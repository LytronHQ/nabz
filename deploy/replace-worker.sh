#!/usr/bin/env bash
#
# replace-worker.sh — replace one worker host with another, keeping its zone
# checking throughout (#418).
#
#   ./deploy/replace-worker.sh <env> <old_ip> <new_ip>
#
# The one manual step comes before this: buy the new server with the fleet's SSH
# public key installed at creation. Deleting the old VM afterwards is manual too —
# every provider's API is different, and this script never touches one.
#
# Each step gates the next, and nothing on the old host changes until the new one
# is built and has proven it can reach PocketBase:
#
#   1. preflight   old is a `worker` line in NODES; new answers ssh with the fleet
#                  key, runs Debian/Ubuntu, is not in NODES and runs no worker
#   2. bootstrap   remote-deploy.sh ONLY_HOST=<new> NO_START=1, with NODES naming
#                  new in old's place: same zone, same `public` flag. Builds and
#                  creates the worker containers but does not start them.
#   3. readiness   remote-deploy's own gate, for that one node (inside step 2)
#   4. drain       stop old's workers with the 30s grace (#417) and wait for exit
#   5. deregister  delete old's worker_heartbeats rows, as the PB superuser, so the
#                  zone re-shards at once instead of after the 45s roster TTL
#   6. start       start the new host's workers
#   7. verify      before VERIFY_SECONDS (< DEADMAN_SECONDS): new's heartbeat row
#                  is fresh, zone_stats was written by new after the start, and a
#                  `checks` row for the zone exists from after the start
#   8. rollback    on any failure after 4: stop new, start old again, exit 1.
#                  Old's containers were only stopped, so it comes back as it was.
#   9. success     print the new NODES block; with UPDATE_NODES_SECRET=1 also
#                  `gh secret set NODES --env <env>`.
#
# Two workers in one zone never run at once: old is stopped (step 4) before new is
# started (step 6). That ordering is what makes the gap non-zero, and keeping it
# short is the point of step 5.
#
# Settings (environment):
#   VERIFY_SECONDS       deadline for step 7 (default 75; must be < DEADMAN_SECONDS),
#                        further capped so a rollback lands inside DEADMAN_SECONDS
#                        counted from the old worker's stop
#   FIRST_BEAT_SECONDS   no heartbeat from the new worker by then = roll back at
#                        once (default 20; a healthy one beats within ~1s)
#   DEADMAN_SECONDS      the evaluator's dead-man threshold (default 90)
#   PB_API_HOST          node the superuser API calls run from (default: the
#                        pocketbase node in NODES — PB_URL is usually a private
#                        address the deploying machine cannot reach, #338)
#   UPDATE_NODES_SECRET  1 = write the new NODES to the GitHub environment secret
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${APP_DIR:-/opt/monitors}"
# `name:` in deploy/worker.yml. Containers are found by this label rather than by
# compose file + profiles, so every replica on the host is drained, whatever
# WORKER_REPLICAS it was deployed with.
WORKER_PROJECT="monitors-worker"

die() { echo "error: $*" >&2; exit 1; }

# --- pure helpers (deploy/replace_worker_test.sh sources this file for these) ---

# nodes_lines — the meaningful lines of a NODES block: no blanks, no comments, no
# `NODES="` / `"` wrapper lines that a pasted provision.sh block carries.
nodes_lines() {
  awk 'NF && $1 !~ /^#/ && $1 != "NODES=\"" && $1 != "\""' <<<"$1"
}

# preflight_nodes NODES old new — prints "<zone> <public-or-empty>" for the old
# worker, or explains on stderr why the replacement is refused and returns 1.
preflight_nodes() {
  local nodes="$1" old="$2" new="$3" lines old_line n role
  [ -n "$old" ] && [ -n "$new" ] || { echo "both old_host and new_host are required" >&2; return 1; }
  case "$old$new" in *[[:space:]]*) echo "a host must be a single address, without spaces" >&2; return 1 ;; esac
  [ "$old" != "$new" ] || { echo "old_host and new_host are the same address ($old)" >&2; return 1; }
  lines="$(nodes_lines "$nodes")"
  [ -n "$lines" ] || { echo "NODES is empty" >&2; return 1; }

  old_line="$(awk -v h="$old" '$2==h' <<<"$lines")"
  n="$(grep -c . <<<"$old_line" || true)"
  [ "$n" != 0 ] || { echo "old_host $old is not in NODES" >&2; return 1; }
  [ "$n" = 1 ] || { echo "old_host $old appears on $n NODES lines; refusing to guess which one" >&2; return 1; }
  role="$(awk '{print $1}' <<<"$old_line")"
  [ "$role" = worker ] || { echo "old_host $old is a '$role' node, not a worker — only workers are replaceable" >&2; return 1; }

  if awk -v h="$new" '$2==h {f=1} END {exit !f}' <<<"$lines"; then
    echo "new_host $new is already in NODES: $(awk -v h="$new" '$2==h' <<<"$lines" | head -1)" >&2
    return 1
  fi

  local zone extra
  zone="$(awk '{print $3}' <<<"$old_line")"
  extra="$(awk '{print $4}' <<<"$old_line")"
  [ -n "$zone" ] || { echo "the NODES line for $old has no zone: $old_line" >&2; return 1; }
  # The free zone writes neither heartbeat rows nor zone_stats (worker/main.go),
  # so step 7 would have nothing to read and would always roll back.
  [ "$zone" != free ] || { echo "the anonymous 'free' zone publishes no heartbeat or zone_stats to verify against; replace it by hand" >&2; return 1; }
  case "$extra" in "" | public) ;; *) echo "the NODES line for $old has an unknown 4th field '$extra'" >&2; return 1 ;; esac
  printf '%s %s\n' "$zone" "$extra"
}

# nodes_swap NODES old new — NODES with the old worker's address replaced by the
# new one. Zone, `public` flag and the position in the list are kept, and every
# other line is left byte-for-byte as it was.
nodes_swap() {
  awk -v o="$2" -v n="$3" '$1=="worker" && $2==o { $2=n } { print }' <<<"$1"
}

# derived_worker_id zone ip — the id remote-deploy.sh's worker_env gives a node.
# Only a fallback: the ids actually in use are read from the containers.
derived_worker_id() {
  printf '%s-%s' "$1" "$(printf '%s' "$2" | tr -c 'a-zA-Z0-9' '-')"
}

# fnv1a32 — worker/schedule.go's hashId (FNV-32a), so this script can tell when
# the new worker will run its first check without asking it.
fnv1a32() {
  local s="$1" h=2166136261 i c
  for ((i = 0; i < ${#s}; i++)); do
    LC_ALL=C printf -v c '%d' "'${s:i:1}"
    h=$(( ((h ^ c) * 16777619) & 0xFFFFFFFF ))
  done
  echo "$h"
}

# first_check_offset ZONE < monitors-json — seconds after start at which a single
# fresh worker in ZONE runs its first check, or nothing when it checks nothing.
#
# A fresh worker staggers each monitor's first check by hash(id) % interval
# (worker/schedule.go startupOffset). For a zone whose monitors all run every 5
# minutes, the first check may legitimately come 4 minutes after the start — so
# "a checks row within the deadline" is only required when one is actually due.
# Input: a PocketBase list response with items {id,type,interval,zones}, enabled
# monitors only.
first_check_offset() {
  local zone="$1" id interval best=""
  while IFS=$'\t' read -r id interval; do
    [ -n "$id" ] || continue
    # models.EffectiveInterval
    if [ "$interval" -le 0 ]; then interval=60; elif [ "$interval" -lt 30 ]; then interval=30; fi
    local off=$(( $(fnv1a32 "$id") % interval ))
    if [ -z "$best" ] || [ "$off" -lt "$best" ]; then best="$off"; fi
  done < <(jq -r --arg z "$zone" '
      .items[]
      | select(.type != "heartbeat")
      | select((.zones // []) | (length == 0 or index($z) != null))
      | [.id, ((.interval // 0) | floor | tostring)] | @tsv')
  [ -z "$best" ] || echo "$best"
}

# heartbeat_rows IDS < worker_heartbeats-list-json — "<row id>\t<worker>\t<updated>"
# for every row whose worker is one of IDS (newline-separated, blank lines ignored).
heartbeat_rows() {
  jq -r --arg ids "$1" '($ids | split("\n") | map(select(length > 0))) as $o
    | .items[] | select(.worker | IN($o[])) | [.id, .worker, .updated] | @tsv'
}

# os_is_debian_like "<ID> <ID_LIKE…>" — from /etc/os-release. Ubuntu, Debian, and
# derivatives that declare either as ID_LIKE.
os_is_debian_like() {
  case " $1 " in *" debian "* | *" ubuntu "*) return 0 ;; esac
  return 1
}

# pb_epoch "2026-10-12 10:00:00.123Z" — PocketBase timestamp to epoch seconds
# (fractional).
pb_epoch() { date -u -d "$1" +%s.%N; }

# ---------------------------------------------------------------------------

main() {
  ENV_NAME="${1:-}"; OLD="${2:-}"; NEW="${3:-}"
  [ -n "$ENV_NAME" ] && [ -n "$OLD" ] && [ -n "$NEW" ] \
    || die "usage: $0 <env> <old_ip> <new_ip>"

  # The same source remote-deploy.sh reads, with the same precedence: a local
  # deploy/<env>.env (the libvirt dev flow) or Bitwarden, then the provisioned
  # values (NODES and friends) from the environment on top.
  local env_file="$HERE/${ENV_NAME}.env"
  if [ ! -f "$env_file" ]; then
    [ -f "$HERE/environments/${ENV_NAME}.vars" ] \
      || die "no $env_file and no deploy/environments/${ENV_NAME}.vars"
    env_file="$("$HERE/bws-env.sh" "$ENV_NAME")"
  fi
  local provisioned="NODES PB_URL PB_BIND_IP PB_DATA_DEVICE PRIVATE_SUBNET" k
  for k in $provisioned; do eval "_ovr_$k=\${$k:-}"; done
  set -a
  # The env file is chosen at run time.
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
  for k in $provisioned; do eval "[ -z \"\${_ovr_$k:-}\" ] || export $k=\"\$_ovr_$k\""; done

  if [ -z "${SSH_KEY:-}" ] && [ -z "${SSH_PRIVATE_KEY:-}" ] && [ -n "${SSH_KEY_FILE:-}" ]; then
    [ -r "$HOME/.ssh/$SSH_KEY_FILE" ] && SSH_KEY="$HOME/.ssh/$SSH_KEY_FILE"
  fi
  if [ -z "${SSH_KEY:-}" ] && [ -n "${SSH_PRIVATE_KEY:-}" ]; then
    SSH_KEY="$(mktemp)"; chmod 600 "$SSH_KEY"
    printf '%s\n' "$SSH_PRIVATE_KEY" > "$SSH_KEY"
    TMP_KEY="$SSH_KEY"
  fi
  [ -n "${SSH_KEY:-}" ] || die "no deploy key for '$ENV_NAME' (SSH_KEY, SSH_KEY_FILE or SSH_PRIVATE_KEY)"
  SSH_KEY="${SSH_KEY/#\~/$HOME}"
  SSH_USER="${SSH_USER:-root}"
  SUDO=""; [ "$SSH_USER" = root ] || SUDO="sudo"
  : "${NODES:?NODES is not set}"
  : "${PB_URL:?PB_URL is not set}"
  : "${PB_SUPERUSER_EMAIL:?PB_SUPERUSER_EMAIL is not set — needed to deregister the old worker}"
  : "${PB_SUPERUSER_PASSWORD:?PB_SUPERUSER_PASSWORD is not set — needed to deregister the old worker}"

  DEADMAN_SECONDS="${DEADMAN_SECONDS:-90}"
  VERIFY_SECONDS="${VERIFY_SECONDS:-75}"
  FIRST_BEAT_SECONDS="${FIRST_BEAT_SECONDS:-20}"
  # Time a rollback needs to bring the old worker back and have it beat: docker
  # stop on the new one (it is not checking, so it exits at once), docker start
  # on the old, its auth and first beat. Measured at ~5s on the lab VMs.
  ROLLBACK_MARGIN="${ROLLBACK_MARGIN:-15}"
  [ "$VERIFY_SECONDS" -lt "$DEADMAN_SECONDS" ] \
    || die "VERIFY_SECONDS ($VERIFY_SECONDS) must be below DEADMAN_SECONDS ($DEADMAN_SECONDS): a zone that is still unverified at the dead-man threshold has already paged"

  WORK="$(mktemp -d)"
  trap 'on_exit' EXIT
  trap 'echo "interrupted" >&2; exit 130' INT TERM

  # ---- 1. preflight --------------------------------------------------------
  echo "==> preflight: $OLD -> $NEW ($ENV_NAME)"
  local pf zone extra
  pf="$(preflight_nodes "$NODES" "$OLD" "$NEW")" || die "preflight refused the replacement (above)"
  zone="${pf%% *}"; extra="${pf#* }"
  echo "   old $OLD is a worker in zone '$zone'${extra:+ ($extra)}"

  local os
  os="$(sshc "$NEW" '. /etc/os-release && printf "%s %s|%s" "$ID" "${ID_LIKE:-}" "$PRETTY_NAME"' </dev/null)" \
    || die "new_host $NEW does not answer ssh as $SSH_USER with the fleet key. Was the key installed when the server was created?"
  os_is_debian_like "${os%%|*}" \
    || die "new_host $NEW runs '${os#*|}'; setup-worker.sh supports Debian/Ubuntu only"
  echo "   new $NEW answers ssh: ${os#*|}"
  # A RUNNING worker there would be a second worker in some zone; refuse. Stopped
  # ones are what a failed earlier attempt leaves behind (rollback stops, never
  # removes), and the bootstrap below recreates them.
  if [ -n "$(remote_worker_containers "$NEW")" ]; then
    die "new_host $NEW is already running a worker, though it is not in NODES; refusing"
  fi
  [ -z "$(remote_worker_containers "$NEW" -a)" ] \
    || echo "   new $NEW has stopped worker containers from an earlier attempt; the bootstrap rebuilds them"

  OLD_CONTAINERS="$(remote_worker_containers "$OLD")" \
    || die "old_host $OLD does not answer ssh; this script drains a live worker (for a dead one, edit NODES and run deploy-nodes)"
  [ -n "$OLD_CONTAINERS" ] || die "old_host $OLD runs no $WORKER_PROJECT container — nothing to drain, and nothing to roll back to"
  OLD_IDS="$(remote_worker_ids "$OLD" $OLD_CONTAINERS)"
  [ -n "$OLD_IDS" ] || OLD_IDS="$(derived_worker_id "$zone" "$OLD")"
  echo "   old worker id(s): $(echo $OLD_IDS)"

  NEW_NODES="$(nodes_swap "$NODES" "$OLD" "$NEW")"

  PB_API_HOST="${PB_API_HOST:-$(nodes_lines "$NODES" | awk '$1=="pocketbase"{print $2; exit}')}"
  [ -n "$PB_API_HOST" ] || die "NODES has no pocketbase line; set PB_API_HOST to a node that can reach $PB_URL"
  pb_login || die "superuser login to PocketBase failed (from $PB_API_HOST). Nothing was changed."
  echo "   PocketBase superuser login works (from $PB_API_HOST)"

  local mons
  mons="$(pb_get "/api/collections/monitors/records?perPage=500&skipTotal=true&fields=id,type,interval,zones&filter=$(uri 'enabled = true')")" \
    || die "could not list monitors"
  FIRST_DUE="$(first_check_offset "$zone" <<<"$mons")"
  # A check needs a moment after its due time to be written; allow 15s for that
  # and for the container to start and authenticate.
  if [ -n "$FIRST_DUE" ] && [ $((FIRST_DUE + 15)) -lt "$VERIFY_SECONDS" ]; then
    REQUIRE_CHECK=1
    echo "   first check due ~${FIRST_DUE}s after start — verification requires a new checks row"
  else
    REQUIRE_CHECK=0
    echo "   no check due within ${VERIFY_SECONDS}s of start (${FIRST_DUE:-no monitors in zone}) — verification uses heartbeat + zone_stats only"
  fi

  # ---- 2+3. bootstrap the new host, not started -------------------------------
  echo "==> bootstrap $NEW (remote-deploy ONLY_HOST, NO_START)"
  if ! NODES="$NEW_NODES" ONLY_HOST="$NEW" NO_START=1 "$HERE/remote-deploy.sh" "$ENV_NAME"; then
    die "bootstrapping $NEW failed. $OLD was not touched; NODES is unchanged."
  fi
  NEW_CONTAINERS="$(remote_worker_containers "$NEW" -a)"
  [ -n "$NEW_CONTAINERS" ] || die "bootstrap reported success but $NEW has no $WORKER_PROJECT containers. $OLD was not touched."
  NEW_IDS="$(remote_worker_ids "$NEW" $NEW_CONTAINERS)"
  [ -n "$NEW_IDS" ] || die "could not read WORKER_ID from the new containers on $NEW. $OLD was not touched."
  NEW_ID="$(head -1 <<<"$NEW_IDS")"
  echo "   new worker id(s): $(echo $NEW_IDS)"

  # Last read before the switch: when the zone was last heard from.
  ZS_BEFORE="$(pb_get "/api/collections/zone_stats/records?perPage=1&skipTotal=true&filter=$(uri "zone = \"$zone\"")" \
    | jq -r '.items[0].updated // empty')" || true

  # ---- 4. drain old -------------------------------------------------------
  echo "==> drain $OLD (SIGTERM, up to 30s for in-flight checks)"
  DRAINED=1   # from here on, any failure rolls back
  local t0 t1
  t0=$(date +%s); T_DRAIN="$t0"
  sshc "$OLD" "$SUDO docker stop -t 30 $(echo $OLD_CONTAINERS)" </dev/null >/dev/null \
    || die "docker stop failed on $OLD"
  t1=$(date +%s)
  [ -z "$(remote_worker_containers "$OLD")" ] || die "$OLD still has running worker containers after stop"
  echo "   stopped in $((t1 - t0))s; exit codes: $(sshc "$OLD" "$SUDO docker inspect -f '{{.Name}}={{.State.ExitCode}}' $(echo $OLD_CONTAINERS)" </dev/null | tr '\n' ' ')"
  echo "   (0 = drained cleanly; 1 = the 25s drain limit gave up; 137 = killed)"

  # ---- 5. deregister old ---------------------------------------------------
  local rows id left
  rows="$(pb_get "/api/collections/worker_heartbeats/records?perPage=200&skipTotal=true&filter=$(uri "zone = \"$zone\"")")" \
    || die "could not read the zone roster"
  OLD_LAST_BEAT="$(heartbeat_rows "$OLD_IDS" <<<"$rows" | cut -f3 | sort | tail -1)"
  # The new ids too: a row left by an earlier attempt on this host would make
  # its `created` lie about when the new worker first beat.
  for id in $(heartbeat_rows "$OLD_IDS"$'\n'"$NEW_IDS" <<<"$rows" | cut -f1); do
    pb_delete "/api/collections/worker_heartbeats/records/$id" || die "deleting heartbeat row $id failed"
  done
  # Read back rather than trust the DELETEs: a row that survives keeps the old
  # worker in the roster for the whole 45s TTL, and the new one checks only its
  # half of the zone meanwhile.
  rows="$(pb_get "/api/collections/worker_heartbeats/records?perPage=200&skipTotal=true&filter=$(uri "zone = \"$zone\"")")" \
    || die "could not re-read the zone roster"
  left="$(heartbeat_rows "$OLD_IDS"$'\n'"$NEW_IDS" <<<"$rows" | cut -f2 | tr '\n' ' ')"
  [ -z "$left" ] || die "heartbeat row(s) still present after delete: $left"
  echo "   removed $OLD's heartbeat row(s); old last beat: ${OLD_LAST_BEAT:-none}; roster now: $(jq -r '[.items[].worker] | join(" ")' <<<"$rows")"

  # ---- 6. start new ---------------------------------------------------------
  START_REF="$(pb_server_time)" || die "could not read PocketBase's clock"
  echo "==> start $NEW (PocketBase time $START_REF)"
  sshc "$NEW" "$SUDO docker start $(echo $NEW_CONTAINERS)" </dev/null >/dev/null || die "docker start failed on $NEW"
  STARTED=1

  # ---- 7. verify --------------------------------------------------------------
  # Two clocks run here. A healthy worker beats within a second or two of its
  # start (it authenticates, then beats before its first reconcile), so no
  # heartbeat after FIRST_BEAT_SECONDS means it is not going to come up — roll
  # back now rather than sit out the full deadline with the zone unchecked. And
  # the whole wait is capped so that a rollback still lands inside the dead-man
  # window, counted from when the old worker stopped beating, not from the start.
  local t_start budget first_beat_by hb_ok=0 zs_ok=0 ck_ok=0 hb zs ck
  t_start=$(date +%s)
  budget=$(( DEADMAN_SECONDS - ROLLBACK_MARGIN - (t_start - T_DRAIN) ))
  [ "$budget" -le "$VERIFY_SECONDS" ] || budget="$VERIFY_SECONDS"
  first_beat_by=$(( t_start + FIRST_BEAT_SECONDS ))
  if [ "$REQUIRE_CHECK" = 1 ] && [ $((FIRST_DUE + 15)) -ge "$budget" ]; then
    REQUIRE_CHECK=0
    echo "   (the first check is due at ~${FIRST_DUE}s, past this run's ${budget}s budget — not required)"
  fi
  [ "$REQUIRE_CHECK" = 1 ] || ck_ok=1
  echo "==> verify within ${budget}s (heartbeat within ${FIRST_BEAT_SECONDS}s; dead-man threshold ${DEADMAN_SECONDS}s)"
  NEW_FIRST_BEAT=""; ZS_AFTER=""; FIRST_CHECK=""
  while :; do
    if [ "$hb_ok" = 0 ]; then
      hb="$(pb_get "/api/collections/worker_heartbeats/records?perPage=1&skipTotal=true&filter=$(uri "zone = \"$zone\" && worker = \"$NEW_ID\" && updated >= \"$START_REF\"")" || echo '{}')"
      NEW_FIRST_BEAT="$(jq -r '.items[0].created // empty' <<<"$hb" 2>/dev/null || true)"
      [ -z "$NEW_FIRST_BEAT" ] || { hb_ok=1; echo "   heartbeat: $NEW_ID first beat at $NEW_FIRST_BEAT"; }
    fi
    if [ "$zs_ok" = 0 ]; then
      zs="$(pb_get "/api/collections/zone_stats/records?perPage=1&skipTotal=true&filter=$(uri "zone = \"$zone\" && worker = \"$NEW_ID\" && updated >= \"$START_REF\"")" || echo '{}')"
      ZS_AFTER="$(jq -r '.items[0].updated // empty' <<<"$zs" 2>/dev/null || true)"
      [ -z "$ZS_AFTER" ] || { zs_ok=1; echo "   zone_stats: written by $NEW_ID at $ZS_AFTER (queue_depth $(jq -r '.items[0].queue_depth' <<<"$zs"), workers $(jq -r '.items[0].workers' <<<"$zs"))"; }
    fi
    if [ "$ck_ok" = 0 ]; then
      ck="$(pb_get "/api/collections/checks/records?perPage=1&skipTotal=true&sort=created&fields=id,created,up&filter=$(uri "zone = \"$zone\" && created >= \"$START_REF\"")" || echo '{}')"
      FIRST_CHECK="$(jq -r '.items[0].created // empty' <<<"$ck" 2>/dev/null || true)"
      [ -z "$FIRST_CHECK" ] || { ck_ok=1; echo "   checks: first row for zone '$zone' since start at $FIRST_CHECK"; }
    fi
    [ "$hb_ok$zs_ok$ck_ok" != 111 ] || break
    local now why=""
    now=$(date +%s)
    if [ "$hb_ok" = 0 ] && [ "$now" -ge "$first_beat_by" ]; then
      why="no heartbeat from $NEW_ID within ${FIRST_BEAT_SECONDS}s of its start"
    elif [ "$now" -ge $(( t_start + budget )) ]; then
      why="not verified within ${budget}s"
    fi
    if [ -n "$why" ]; then
      echo "VERIFY FAILED: $why — heartbeat=$hb_ok zone_stats=$zs_ok checks=$ck_ok (1 = seen)" >&2
      echo "   last log lines of the new worker:" >&2
      sshc "$NEW" "$SUDO docker logs --tail 15 $(head -1 <<<"$NEW_CONTAINERS") 2>&1" </dev/null | sed 's/^/     /' >&2 || true
      exit 1   # on_exit rolls back
    fi
    sleep 2
  done
  VERIFIED=1

  # ---- 9. success -----------------------------------------------------------
  local gap="" zs_gap=""
  [ -z "${OLD_LAST_BEAT:-}" ] || gap="$(awk -v a="$(pb_epoch "$OLD_LAST_BEAT")" -v b="$(pb_epoch "$NEW_FIRST_BEAT")" 'BEGIN{printf "%.1f", b-a}')"
  [ -z "${ZS_BEFORE:-}" ] || zs_gap="$(awk -v a="$(pb_epoch "$ZS_BEFORE")" -v b="$(pb_epoch "$ZS_AFTER")" 'BEGIN{printf "%.1f", b-a}')"

  echo
  echo "==> replaced $OLD with $NEW in zone '$zone'"
  echo "   old worker id(s):  $(echo $OLD_IDS)"
  echo "   new worker id(s):  $(echo $NEW_IDS)"
  echo "   heartbeat gap:     ${gap:-unknown}s  (old last beat ${OLD_LAST_BEAT:-?} -> new first beat $NEW_FIRST_BEAT)"
  echo "   zone_stats gap:    ${zs_gap:-unknown}s  (${ZS_BEFORE:-?} -> $ZS_AFTER; dead-man threshold ${DEADMAN_SECONDS}s)"
  echo "   first check:       ${FIRST_CHECK:-not required within the deadline}"
  echo "   $OLD is drained (containers stopped, not removed) and safe to delete."
  echo
  echo "NODES is now:"
  echo "$NEW_NODES"

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### replace-worker: \`$OLD\` → \`$NEW\` (zone \`$zone\`, $ENV_NAME)"
      echo
      echo "| | |"
      echo "|---|---|"
      echo "| old worker id(s) | $(echo $OLD_IDS) |"
      echo "| new worker id(s) | $(echo $NEW_IDS) |"
      echo "| heartbeat gap | ${gap:-unknown}s |"
      echo "| zone_stats gap | ${zs_gap:-unknown}s (dead-man ${DEADMAN_SECONDS}s) |"
      echo "| first check after start | ${FIRST_CHECK:-not due within the deadline} |"
      echo
      echo "\`$OLD\` is drained and safe to delete at its provider."
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  if [ "${UPDATE_NODES_SECRET:-}" = 1 ]; then
    command -v gh >/dev/null 2>&1 || die "UPDATE_NODES_SECRET=1 but gh is not installed. The replacement SUCCEEDED; set NODES by hand to the block above."
    [ -n "${GH_TOKEN:-}" ] || die "UPDATE_NODES_SECRET=1 but GH_TOKEN is not set. The replacement SUCCEEDED; set NODES by hand to the block above."
    # stdin, not --body: the value stays out of the process list.
    printf '%s' "$NEW_NODES" | gh secret set NODES --env "$ENV_NAME" ${GITHUB_REPOSITORY:+--repo "$GITHUB_REPOSITORY"} \
      || die "gh secret set NODES failed. The replacement SUCCEEDED and $NEW is serving zone '$zone'; set NODES by hand to the block above, or the next deploy-nodes redeploys $OLD."
    echo "   NODES secret updated for environment '$ENV_NAME'"
  else
    echo "   (NODES secret not written — set UPDATE_NODES_SECRET=1, or update it by hand, before the next deploy-nodes)"
  fi
}

# --- remote helpers ----------------------------------------------------------

# Same options as remote-deploy.sh's sshc (see the IdentitiesOnly note there),
# plus BatchMode: an unattended run must fail on a missing key, not prompt.
sshc() {
  ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
    -o SetEnv=LC_ALL=C.UTF-8 "${SSH_USER}@$1" "$2"
}

# remote_worker_containers host [-a] — ids of this host's worker containers
# (running only, or all with -a). Fails if the host does not answer.
remote_worker_containers() {
  sshc "$1" "$SUDO docker ps -q ${2:-} --filter label=com.docker.compose.project=$WORKER_PROJECT 2>/dev/null || true" </dev/null
}

# remote_worker_ids host container… — the WORKER_ID each container runs with,
# sorted. Read from the containers rather than derived, so replicas (-2, -3…) and
# a hand-set WORKER_ID are both covered.
remote_worker_ids() {
  local host="$1"; shift
  sshc "$host" "$SUDO docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $*" </dev/null \
    | sed -n 's/^WORKER_ID=//p' | grep . | sort -u
}

uri() { jq -rn --arg s "$1" '$s | @uri'; }

# pb_call METHOD PATH [JSON] — one PocketBase API request, made FROM PB_API_HOST.
# Prints the body, then the HTTP status on a last line of its own. The token and
# any body travel on ssh's stdin, never on a command line.
pb_call() {
  local method="$1" path="$2" body="${3:-}"
  {
    printf 'U=%q\nT=%q\nM=%q\nB=%q\n' "${PB_URL%/}$path" "${PB_TOKEN:-}" "$method" "$body"
    cat <<'REMOTE'
args=(-sS --max-time 15 -X "$M" -w '\n%{http_code}')
[ -z "$T" ] || args+=(-H "Authorization: $T")
[ -z "$B" ] || args+=(-H 'Content-Type: application/json' --data-binary "$B")
curl "${args[@]}" "$U"
REMOTE
  } | sshc "$PB_API_HOST" "bash -s"
}

# pb_get PATH — the body of a successful GET, or return 1.
pb_get() {
  local out code
  out="$(pb_call GET "$1")" || return 1
  code="${out##*$'\n'}"
  [ "${code:0:1}" = 2 ] || { echo "   PocketBase GET ${1%%\?*} -> HTTP $code" >&2; return 1; }
  printf '%s\n' "${out%$'\n'*}"
}

# pb_delete PATH — succeed only on a 2xx.
pb_delete() {
  local out code
  out="$(pb_call DELETE "$1")" || return 1
  code="${out##*$'\n'}"
  [ "${code:0:1}" = 2 ] || { echo "   PocketBase DELETE $1 -> HTTP $code" >&2; return 1; }
}

pb_login() {
  local out code body
  body="$(jq -nc --arg i "$PB_SUPERUSER_EMAIL" --arg p "$PB_SUPERUSER_PASSWORD" '{identity:$i,password:$p}')"
  out="$(PB_TOKEN="" pb_call POST /api/collections/_superusers/auth-with-password "$body")" || return 1
  code="${out##*$'\n'}"
  [ "$code" = 200 ] || return 1
  PB_TOKEN="$(jq -r '.token // empty' <<<"${out%$'\n'*}")"
  [ -n "$PB_TOKEN" ]
}

# pb_server_time — PocketBase's own clock, as "YYYY-MM-DD HH:MM:SS" (UTC), from
# the Date header. Every "after the start" comparison uses PocketBase's clock,
# because that is the clock that stamps `created`/`updated`; the deploying
# machine's is irrelevant and may be minutes off.
pb_server_time() {
  local d
  d="$(printf 'U=%q\n%s\n' "${PB_URL%/}/api/health" 'curl -sS --max-time 10 -o /dev/null -D - "$U"' \
        | sshc "$PB_API_HOST" "bash -s" | tr -d '\r' | sed -n 's/^[Dd]ate: //p')"
  [ -n "$d" ] || return 1
  date -u -d "$d" '+%Y-%m-%d %H:%M:%S'
}

# --- exit: roll back if the new worker was not verified ----------------------
on_exit() {
  local rc=$?
  if [ "${DRAINED:-0}" = 1 ] && [ "${VERIFIED:-0}" != 1 ]; then
    echo "==> ROLLBACK: restoring $OLD" >&2
    if [ "${STARTED:-0}" = 1 ] && [ -n "${NEW_CONTAINERS:-}" ]; then
      sshc "$NEW" "$SUDO docker stop -t 30 $(echo $NEW_CONTAINERS)" </dev/null >/dev/null \
        && echo "   stopped the new worker on $NEW" >&2 \
        || echo "   WARNING: could not stop the worker on $NEW — stop it by hand, or the zone runs two workers" >&2
    fi
    if sshc "$OLD" "$SUDO docker start $(echo $OLD_CONTAINERS)" </dev/null >/dev/null; then
      echo "   started $OLD's worker(s) again: $(echo $OLD_IDS)" >&2
      echo "   $OLD runs exactly what it ran before; NODES is unchanged." >&2
    else
      echo "   ROLLBACK FAILED: could not start the worker on $OLD. Zone has NO worker — start it by hand:" >&2
      echo "     ssh $OLD sudo docker start $(echo $OLD_CONTAINERS)" >&2
    fi
    [ "$rc" != 0 ] || rc=1
  fi
  [ -z "${WORK:-}" ] || rm -rf "$WORK"
  [ -z "${TMP_KEY:-}" ] || rm -f "$TMP_KEY"
  exit "$rc"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
