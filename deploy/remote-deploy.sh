#!/usr/bin/env bash
#
# Deploy monitors nodes to a set of remote hosts, from your laptop, over SSH.
# One command per environment; all settings (SSH key, host IPs, PB creds) come
# from Bitwarden Secrets Manager (prod/staging) or deploy/<env>.env (dev).
#
#   ./deploy/remote-deploy.sh dev     # reads deploy/dev.env   (local VMs)
#   ./deploy/remote-deploy.sh production   # secrets from Bitwarden (Hetzner)
#
# For each host it: pushes /etc/monitors/<role>.env, then runs the on-host
# setup script over SSH (which installs Docker, clones the repo, and
# `docker compose up -d`). Re-run any time to update.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
APP_DIR="${APP_DIR:-/opt/monitors}"
ENV_NAME="${1:-}"
[ -n "$ENV_NAME" ] || { echo "usage: $0 <env>    (reads deploy/<env>.env)"; exit 1; }
# Secret values come from Bitwarden Secrets Manager; the repo holds no plaintext.
# A local deploy/<env>.env still wins when present — that is the libvirt dev flow,
# which has no BWS project.
ENV_FILE="$HERE/${ENV_NAME}.env"
if [ ! -f "$ENV_FILE" ]; then
  [ -f "$HERE/environments/${ENV_NAME}.vars" ] || {
    echo "No $ENV_FILE and no deploy/environments/${ENV_NAME}.vars — nothing to deploy from."; exit 1; }
  echo "==> materializing '$ENV_NAME' from Bitwarden Secrets Manager"
  ENV_FILE="$("$HERE/bws-env.sh" "$ENV_NAME")"
fi

# Provisioning outputs describe infrastructure that exists right now: which hosts,
# which IPs, which data device. infra-hetzner reads them from the Hetzner API and
# passes them in, so they must beat any stored copy — a rebuilt server changes its
# IP, and a deploy that trusts a stale one SSHes confidently into the wrong place.
PROVISIONED="NODES PB_URL PB_BIND_IP PB_DATA_DEVICE PRIVATE_SUBNET"
for k in $PROVISIONED; do eval "_ovr_$k=\${$k:-}"; done

set -a; . "$ENV_FILE"; set +a

for k in $PROVISIONED; do
  eval "_v=\$_ovr_$k"
  [ -n "${_v:-}" ] && eval "export $k=\$_ovr_$k"
done
unset _v

# Bitwarden stores the key itself (SSH_PRIVATE_KEY); ssh needs a file. Write it
# to a private temp file for the life of this run rather than asking the operator
# to keep a path and a key in sync.
# On a laptop the key is simply a file in ~/.ssh, named by SSH_KEY_FILE in the
# environment's vars. It is never copied into Bitwarden, so this is how a local
# deploy finds it; CI passes SSH_PRIVATE_KEY instead.
if [ -z "${SSH_KEY:-}" ] && [ -z "${SSH_PRIVATE_KEY:-}" ] && [ -n "${SSH_KEY_FILE:-}" ]; then
  [ -r "$HOME/.ssh/$SSH_KEY_FILE" ] \
    && SSH_KEY="$HOME/.ssh/$SSH_KEY_FILE" \
    || die_msg="no readable ~/.ssh/$SSH_KEY_FILE"
fi

if [ -z "${SSH_KEY:-}" ] && [ -n "${SSH_PRIVATE_KEY:-}" ]; then
  SSH_KEY="$(mktemp)"; chmod 600 "$SSH_KEY"
  printf '%s\n' "$SSH_PRIVATE_KEY" > "$SSH_KEY"
  trap 'rm -f "$SSH_KEY"' EXIT
fi

# The ping URL is not configuration: Better Stack owns it, and the API token that
# created the heartbeat can read it back. Storing a copy only creates something
# that can go stale or be forgotten — the evaluator then runs with its dead-man's
# switch silently off, which is the exact failure the switch exists to catch.
# An explicit HEALTHCHECK_PING_URL still wins, and lookup failure is never fatal.
# Same read-it-back-from-the-owner approach for the maintenance heartbeat (#322):
# Better Stack owns the URL, and storing a copy only creates something that can go
# stale while the backup quietly stops being watched.
if [ -z "${PB_MAINTENANCE_PING_URL:-}" ] && [ -n "${BETTERSTACK_API_TOKEN:-}" ]; then
  PB_MAINTENANCE_PING_URL="$(curl -sS --max-time 10 "https://uptime.betterstack.com/api/v2/heartbeats" \
    -H "Authorization: Bearer $BETTERSTACK_API_TOKEN" 2>/dev/null \
    | jq -r --arg n "nabz-pb-maintenance ($ENV_NAME)" \
        '.data[]? | select(.attributes.name == $n) | .attributes.url // empty' | head -1)" || true
  [ -n "${PB_MAINTENANCE_PING_URL:-}" ] \
    && echo "==> maintenance heartbeat: resolved from Better Stack" \
    || echo "WARNING: no Better Stack heartbeat named 'nabz-pb-maintenance ($ENV_NAME)'; run infra-watch." >&2
fi

if [ -z "${HEALTHCHECK_PING_URL:-}" ] && [ -n "${BETTERSTACK_API_TOKEN:-}" ]; then
  HEALTHCHECK_PING_URL="$(curl -sS --max-time 10 "https://uptime.betterstack.com/api/v2/heartbeats" \
    -H "Authorization: Bearer $BETTERSTACK_API_TOKEN" 2>/dev/null \
    | jq -r --arg n "nabz-evaluator ($ENV_NAME)" \
        '.data[]? | select(.attributes.name == $n) | .attributes.url // empty' | head -1)" || true
  if [ -n "${HEALTHCHECK_PING_URL:-}" ]; then
    echo "==> dead-man's switch: resolved from Better Stack"
  else
    echo "WARNING: no Better Stack heartbeat named 'nabz-evaluator ($ENV_NAME)'." >&2
    echo "         Run infra-watch for this environment; until then the evaluator" >&2
    echo "         runs with its dead-man's switch off." >&2
  fi
fi

[ -n "${SSH_KEY:-}" ] || {
  echo "error: no deploy key for '$ENV_NAME'${die_msg:+ — $die_msg}." >&2
  echo "  Set SSH_KEY_FILE in deploy/environments/${ENV_NAME}.vars to a key in ~/.ssh," >&2
  echo "  or pass SSH_PRIVATE_KEY (which is what CI does)." >&2
  exit 1; }
: "${PB_URL:?set PB_URL in $ENV_FILE}"
: "${NODES:?set NODES in $ENV_FILE}"
SSH_USER="${SSH_USER:-root}"
PB_AUTH_COLLECTION="${PB_AUTH_COLLECTION:-service_accounts}"
SSH_KEY="${SSH_KEY/#\~/$HOME}"
SUDO=""; [ "$SSH_USER" != "root" ] && SUDO="sudo"

# Build stamp for the health debug tier (#103): the version + commit this deploy
# ships. Computed here on the deploying machine (the nodes get no .git). A deploy
# carries the working tree (tracked files), so flag uncommitted changes as -dirty.
BUILD_VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION" 2>/dev/null || echo dev)"
BUILD_COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
git -C "$REPO_ROOT" diff --quiet 2>/dev/null || BUILD_COMMIT="${BUILD_COMMIT}-dirty"

# SetEnv=LC_ALL=C.UTF-8 overrides the client locale SSH would otherwise forward
# (e.g. en_GB.UTF-8), which a minimal node lacks -> stops perl/dpkg locale spam.
sshc() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
  -o SetEnv=LC_ALL=C.UTF-8 "${SSH_USER}@$1" "$2"; }

push_env() { # host role content
  # An empty body is never legitimate, and it is reachable: the callers pass
  # "$(role_env …)", and a ${VAR:?} inside a command substitution in ARGUMENT
  # position has its exit status discarded — `set -e` does not fire. So a missing
  # WORKER_PB_PASSWORD produced a zero-byte /etc/monitors/worker.env, setup's
  # `[ ! -f "$ENV_FILE" ]` guard passed because the file existed, and the node was
  # deployed with no configuration at all. Verified by repro: push_env received 0
  # bytes and the script continued.
  [ -n "$3" ] || {
    echo "refusing to write an EMPTY /etc/monitors/$2.env to $1." >&2
    echo "  A required value was unset while composing it — the line above naming" >&2
    echo "  a variable as null or not set is the one to fix." >&2
    exit 1
  }
  sshc "$1" "$SUDO mkdir -p /etc/monitors && $SUDO tee /etc/monitors/$2.env >/dev/null && $SUDO chmod 600 /etc/monitors/$2.env" <<<"$3"
}
push_code() { # host — ship the local working tree (tracked files only: respects
  # .gitignore, so no secrets/node_modules/.git). No GitHub access needed on nodes.
  command -v git >/dev/null 2>&1 || { echo "git required on this laptop"; exit 1; }
  git -C "$REPO_ROOT" ls-files -z \
    | tar -C "$REPO_ROOT" --null -T - -cf - \
    | sshc "$1" "$SUDO rm -rf $APP_DIR && $SUDO mkdir -p $APP_DIR && $SUDO tar xf - -C $APP_DIR"
}
run_setup() { # host role — SKIP_CLONE: use the code we just pushed, don't git clone
  sshc "$1" "$SUDO SKIP_CLONE=1 bash -s" <"$HERE/setup-$2.sh"
}

# pocketbase.env is SOURCED BY BASH on the host (setup-pocketbase.sh does
# `set -a; . "$ENV_FILE"`), unlike the worker/evaluator/web files which go to
# `docker compose --env-file` and are parsed literally. So every value here has
# to be shell-quoted: PB_BACKUP_CRON's default "0 3 * * *" otherwise assigns
# PB_BACKUP_CRON=0 and then tries to RUN `3`, aborting the whole setup under
# `set -e` before PocketBase is ever started.
kv() { printf "%s='%s'\n" "$1" "$(printf '%s' "${2:-}" | sed "s/'/'\\\\''/g")"; }

pocketbase_env() {
  # Service accounts are seeded from the same WORKER_PB_*/EVALUATOR_PB_* creds
  # the worker/evaluator nodes authenticate with, so they stay in sync. App
  # name/URL, PB's own SMTP, and R2 backups are applied via /api/settings — no
  # admin-UI clicks. All optional except the superuser + version.
  kv PB_SUPERUSER_EMAIL    "${PB_SUPERUSER_EMAIL:?set PB_SUPERUSER_EMAIL in $ENV_FILE}"
  kv PB_SUPERUSER_PASSWORD "${PB_SUPERUSER_PASSWORD:?set PB_SUPERUSER_PASSWORD in $ENV_FILE}"
  kv PB_VERSION            "${PB_VERSION:-0.28.4}"
  kv PB_SHA256             "${PB_SHA256:-}"
  kv PB_DATA_DEVICE        "${PB_DATA_DEVICE:-}"
  kv PB_DATA_MOUNT         "${PB_DATA_MOUNT:-/mnt/pb-data}"
  kv PB_BIND_IP            "${PB_BIND_IP:-}"
  kv PRIVATE_SUBNET        "${PRIVATE_SUBNET:-}"
  kv TUNNEL_TOKEN          "${TUNNEL_TOKEN:-}"
  kv CLOUDFLARED_VERSION   "${CLOUDFLARED_VERSION:-2026.8.2}"
  kv PB_LOGS_MIN_LEVEL     "${PB_LOGS_MIN_LEVEL:-4}"
  kv SEED_WORKER_USERNAME     "${WORKER_PB_USERNAME:-}"
  kv SEED_WORKER_PASSWORD     "${WORKER_PB_PASSWORD:-}"
  kv SEED_EVALUATOR_USERNAME  "${EVALUATOR_PB_USERNAME:-}"
  kv SEED_EVALUATOR_PASSWORD  "${EVALUATOR_PB_PASSWORD:-}"
  # Default APP users (#392) — ordinary users, not service accounts. Seeded with a
  # shared password and must_change_password=true, so it cannot survive first
  # sign-in. Existing records are never touched by a re-run.
  kv SEED_ADMIN_EMAIL      "${SEED_ADMIN_EMAIL:-admin@nabz.sh}"
  kv SEED_USER_EMAIL       "${SEED_USER_EMAIL:-user@nabz.sh}"
  kv SEED_PASSWORD         "${SEED_PASSWORD:-demo1234}"
  kv PB_APP_NAME           "${PB_APP_NAME:-nabz}"
  kv PB_APP_URL            "${PB_APP_URL:-}"
  kv PB_SENDER_NAME        "${PB_SENDER_NAME:-nabz}"
  kv PB_SENDER_ADDRESS     "${PB_SENDER_ADDRESS:-}"
  kv PB_SMTP_HOST          "${PB_SMTP_HOST:-}"
  kv PB_SMTP_PORT          "${PB_SMTP_PORT:-587}"
  kv PB_SMTP_USERNAME      "${PB_SMTP_USERNAME:-}"
  kv PB_SMTP_PASSWORD      "${PB_SMTP_PASSWORD:-}"
  kv PB_SMTP_TLS           "${PB_SMTP_TLS:-false}"
  kv PB_BACKUP_S3_ENDPOINT "${PB_BACKUP_S3_ENDPOINT:-}"
  kv PB_BACKUP_S3_BUCKET   "${PB_BACKUP_S3_BUCKET:-}"
  kv PB_BACKUP_S3_REGION   "${PB_BACKUP_S3_REGION:-auto}"
  kv PB_BACKUP_S3_ACCESS_KEY "${PB_BACKUP_S3_ACCESS_KEY:-}"
  kv PB_BACKUP_S3_SECRET   "${PB_BACKUP_S3_SECRET:-}"
  # Both default to OFF (#322). The maintenance timer drives backups so they land
  # after the checkpoint and vacuum, and so PocketBase's own cronMaxKeep does not
  # prune the bucket R2 lifecycle expiry already prunes.
  kv PB_BACKUP_CRON        "${PB_BACKUP_CRON:-}"
  kv PB_BACKUP_MAX_KEEP    "${PB_BACKUP_MAX_KEEP:-0}"
  # Maintenance run (#322): how many free pages one bounded vacuum may reclaim,
  # when the timer fires, and an optional heartbeat pinged only on success so the
  # external monitor alerts on silence.
  kv PB_VACUUM_PAGES       "${PB_VACUUM_PAGES:-20000}"
  kv PB_MAINTENANCE_ONCALENDAR "${PB_MAINTENANCE_ONCALENDAR:-*-*-* 03:17:00}"
  kv PB_MAINTENANCE_PING_URL   "${PB_MAINTENANCE_PING_URL:-}"
}
web_env() { # ip
  # The public /ping/{token} heartbeat endpoint records a check-in with a service
  # account: it updates the monitor (any service_account may) AND writes a `checks`
  # row for history (create rule = role "worker"). Default it to the worker creds
  # unless a dedicated account is provided via WEB_PB_USERNAME/WEB_PB_PASSWORD.
  cat <<EOF
PB_URL=${PB_URL}
PKCE_FLOW_ENCRYPTION_KEY=${PKCE_FLOW_ENCRYPTION_KEY:-dev-only-not-a-secret}
ORIGIN=http://${1}:3000
NODE_ENV=${WEB_NODE_ENV:-}
WEB_PB_COLLECTION=${PB_AUTH_COLLECTION:-service_accounts}
WEB_PB_USERNAME=${WEB_PB_USERNAME:-${WORKER_PB_USERNAME:-}}
WEB_PB_PASSWORD=${WEB_PB_PASSWORD:-${WORKER_PB_PASSWORD:-}}
HEALTH_DEBUG_TOKEN=${HEALTH_DEBUG_TOKEN:-}
HEALTH_STALE_SECONDS=${HEALTH_STALE_SECONDS:-90}
ADMIN_EMAILS=${ADMIN_EMAILS:-}
# Secure flag on the auth cookie (#394). Defaults to on; set false ONLY for a
# fleet served over plain HTTP, such as the libvirt dev VMs — a browser silently
# discards a Secure cookie on an http:// origin, and the symptom is a sign-in that
# bounces back to /signin as though the password were wrong.
COOKIE_SECURE=${COOKIE_SECURE:-true}
EOF
}
worker_env() { # zone
  cat <<EOF
PB_URL=${PB_URL}
PB_AUTH_COLLECTION=${PB_AUTH_COLLECTION}
PB_ADMIN_USERNAME=${WORKER_PB_USERNAME:?set WORKER_PB_USERNAME in $ENV_FILE}
PB_ADMIN_PASSWORD=${WORKER_PB_PASSWORD:?set WORKER_PB_PASSWORD in $ENV_FILE}
REGION_NAME=${1}
PRIVATE_SUBNET=${PRIVATE_SUBNET:-}
# The anonymous "free" zone runs untrusted URLs, so it enforces the SSRF guard
# (#268); real zones leave it off. Empty here = off (worker.yml default).
BLOCK_PRIVATE_TARGETS=$([ "${1}" = "free" ] && echo true)
HEALTH_DEBUG_TOKEN=${HEALTH_DEBUG_TOKEN:-}
# A range, not a single port (#311): N replicas on one node each need their own
# host port, and a fixed one allows exactly one container.
HEALTH_PORT_RANGE=${HEALTH_PORT_RANGE:-8080-8099}
# Shared zone Valkey (#311). Blank CACHE_HOST keeps the per-node sidecar, which
# is what a single-VM zone uses; set both to spread one zone across VMs. Every
# worker in a zone must point at the SAME instance.
CACHE_HOST=${CACHE_HOST:-valkey}
CACHE_PORT=${CACHE_PORT:-6379}
CACHE_PASSWORD=${CACHE_PASSWORD:-}
# Blank = container hostname, already unique per replica.
WORKER_ID=${WORKER_ID:-}
# Replicas of the worker on this node; they share its Valkey and elect one seeder.
WORKER_REPLICAS=${WORKER_REPLICAS:-1}
BUILD_VERSION=${BUILD_VERSION}
BUILD_COMMIT=${BUILD_COMMIT}
EOF
}
evaluator_env() {
  cat <<EOF
PB_URL=${PB_URL}
PB_AUTH_COLLECTION=${PB_AUTH_COLLECTION}
PB_ADMIN_USERNAME=${EVALUATOR_PB_USERNAME:?set EVALUATOR_PB_USERNAME in $ENV_FILE}
PB_ADMIN_PASSWORD=${EVALUATOR_PB_PASSWORD:?set EVALUATOR_PB_PASSWORD in $ENV_FILE}
SMTP_HOST=${SMTP_HOST:-}
SMTP_PORT=${SMTP_PORT:-587}
SMTP_USERNAME=${SMTP_USERNAME:-}
SMTP_PASSWORD=${SMTP_PASSWORD:-}
SMTP_FROM=${SMTP_FROM:-}
OPS_WEBHOOK_URL=${OPS_WEBHOOK_URL:-}
HEALTHCHECK_PING_URL=${HEALTHCHECK_PING_URL:-}
DEADMAN_SECONDS=${DEADMAN_SECONDS:-90}
CERT_EXPIRY_WARN_DAYS=${CERT_EXPIRY_WARN_DAYS:-14}
PRIVATE_SUBNET=${PRIVATE_SUBNET:-}
HEALTH_DEBUG_TOKEN=${HEALTH_DEBUG_TOKEN:-}
HEALTH_PORT=${HEALTH_PORT:-8080}
BUILD_VERSION=${BUILD_VERSION}
BUILD_COMMIT=${BUILD_COMMIT}
EOF
}

# --- readiness gate ---------------------------------------------------------
# The failure this guards against is a quiet one: worker/evaluator authenticate
# to PocketBase with NewClientWithRetry, which retries FOREVER on failure, and
# an unhealthy container is never restarted by `restart: unless-stopped`. So a
# deploy against a PocketBase that is missing its schema or its service accounts
# exits 0, prints "All nodes deployed", and leaves the fleet spinning in an auth
# loop that only shows up in `docker ps` or the container logs.
#
# Prove the thing the nodes actually need — this role's service account can log
# in AND read a collection — before shipping anything to a node.
# Set SKIP_PB_READINESS=1 to bypass (e.g. PB unreachable from here by design).
# Run FROM A NODE, not from here (#338). Once PocketBase is on the Hetzner
# private network, PB_URL is a 10.x address the deploying machine cannot reach —
# checking from here would abort every single deploy. The probes are unchanged;
# only the vantage point moves to a host that shares the private network.
# Can THIS node reach PocketBase at all? pb_ready answers "are the credentials and
# schema right", which is a property of PocketBase and needs only one vantage
# point. This answers "does this particular machine have a route", which is a
# property of the node — and the two are not the same question.
#
# Staging deployed a worker whose private NIC was never configured: the cloud API
# reported the address attached, PocketBase was listening on it, the firewall
# allowed it, and pb_ready passed because it ran from the PocketBase node. The
# worker itself could not route there, retried auth forever, was never marked
# unhealthy, and the deploy reported success.
#
# Uses bash's /dev/tcp rather than curl: this runs before the node has been given
# any packages, and a missing curl would abort the deploy instead of testing it.
pb_route_ok() { # role ip
  local role="$1" ip="$2" hostport host port
  hostport="${PB_URL#*://}"; hostport="${hostport%%/*}"
  host="${hostport%%:*}"; port="${hostport##*:}"
  [ "$port" != "$host" ] || port=80
  if sshc "$ip" "timeout 8 bash -c 'exec 3<>/dev/tcp/${host}/${port}'" >/dev/null 2>&1; then
    return 0
  fi
  echo "PRIVATE ROUTE FAILED for $role at $ip: cannot open ${host}:${port}."
  echo "  PocketBase is reachable from elsewhere, so this is this node's network, not PB."
  echo "  The usual cause is a Hetzner private NIC attached cloud-side but never"
  echo "  configured in the guest — cloud-init wrote its config before the attach."
  echo "  Check 'ip -4 addr' on the node; a reboot regenerates it."
  return 1
}

pb_ready() { # role ENVPREFIX username password
  local role="$1" prefix="$2" user="$3" pass="$4" remote
  # Missing credentials used to "skip" — returning success for the condition with
  # the largest blast radius, and the same condition that truncates the node's env
  # file. The role is in NODES, so its credentials are required; absent is a
  # failure, not an exemption.
  [ -n "$user" ] && [ -n "$pass" ] || {
    echo "   readiness: ${prefix}_PB_USERNAME/${prefix}_PB_PASSWORD are not set, but a"
    echo "   '$role' node is listed in NODES. It cannot authenticate to PocketBase,"
    echo "   and its env file would be written empty. Set them in $ENV_FILE."
    return 1
  }
  if [ -z "${GATE_HOST:-}" ]; then
    echo "   readiness: no node available to check from — skipping"
    return 0
  fi
  # Values are quoted for the remote shell here; the remote script only ever
  # expands them as variables.
  remote="$(printf 'PB_URL=%q COLL=%q PB_U=%q PB_P=%q bash -s' \
    "$PB_URL" "$PB_AUTH_COLLECTION" "$user" "$pass")"
  if sshc "$GATE_HOST" "$remote" >/dev/null 2>&1 <<'REMOTE'
tok="$(curl -fsS --max-time 15 -H 'Content-Type: application/json' \
  -d "{\"identity\":\"${PB_U}\",\"password\":\"${PB_P}\"}" \
  "${PB_URL%/}/api/collections/${COLL}/auth-with-password" \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$tok" ] || exit 1
curl -fsS --max-time 15 -H "Authorization: $tok" \
  "${PB_URL%/}/api/collections/monitors/records?perPage=1&skipTotal=true" >/dev/null || exit 2
REMOTE
  then
    echo "   readiness: $role account authenticates and can read monitors (checked from $GATE_HOST)"
    return 0
  fi
  echo "PocketBase readiness FAILED for $role at $PB_URL (checked from $GATE_HOST)."
  echo "  Either the '$PB_AUTH_COLLECTION' collection / the $role account is missing — deploy the"
  echo "  'pocketbase' node first (setup-pocketbase.sh imports the schema and seeds the accounts) —"
  echo "  or ${prefix}_PB_USERNAME/${prefix}_PB_PASSWORD in $ENV_FILE are wrong, or the node cannot"
  echo "  reach PB_URL over the private network."
  echo "  Refusing to deploy $role: it would retry auth forever and look healthy from the outside."
  return 1
}

# Deploy pocketbase FIRST regardless of where its line sits in NODES: it imports
# the schema and seeds the service accounts every other role authenticates with.
# Two passes rather than a documented ordering rule nobody re-reads.
deploy_node() { # role ip zone
  local role="$1" ip="$2" zone="$3"
  case "$role" in
    pocketbase)
      [ -n "${ip:-}" ] || { echo "bad NODES line (need: pocketbase <ip>): $role"; exit 1; }
      echo "==> pocketbase  $ip"
      push_env "$ip" pocketbase "$(pocketbase_env)"
      push_code "$ip"
      run_setup "$ip" pocketbase
      ;;
    worker)
      [ -n "${ip:-}" ] && [ -n "${zone:-}" ] || { echo "bad NODES line (need: worker <ip> <zone>): $role $ip $zone"; exit 1; }
      echo "==> worker  $ip  (zone=$zone)"
      push_env "$ip" worker "$(worker_env "$zone")"
      push_code "$ip"
      run_setup "$ip" worker
      ;;
    evaluator)
      [ -n "${ip:-}" ] || { echo "bad NODES line (need: evaluator <ip>): $role"; exit 1; }
      echo "==> evaluator  $ip"
      push_env "$ip" evaluator "$(evaluator_env)"
      push_code "$ip"
      run_setup "$ip" evaluator
      ;;
    web)
      [ -n "${ip:-}" ] || { echo "bad NODES line (need: web <ip>): $role"; exit 1; }
      echo "==> web  $ip"
      push_env "$ip" web "$(web_env "$ip")"
      push_code "$ip"
      run_setup "$ip" web
      ;;
    # provision.sh prints NODES as a ready-to-paste `NODES="…"` block, so a
    # hand-copied value can carry the wrapper. Skip it rather than reporting the
    # quote character as an unknown role.
    'NODES="' | '"') return 0 ;;
    *) echo "unknown role '$role' in NODES"; exit 1 ;;
  esac
}

# The host the readiness gate runs from: the pocketbase node when there is one
# (it is deployed first and is on the private network), otherwise the first node
# listed — any fleet host shares the network and only needs ssh + curl.
GATE_HOST="$(awk '$1=="pocketbase"{print $2; exit}' <<<"$NODES")"
[ -n "$GATE_HOST" ] || GATE_HOST="$(awk 'NF && $1 !~ /^#/ {print $2; exit}' <<<"$NODES")"

# Pass 1 — pocketbase, wherever it appears in NODES.
while read -r role ip zone _; do
  case "${role:-}" in "" | \#*) continue ;; pocketbase) deploy_node "$role" "${ip:-}" "${zone:-}" ;; esac
done <<<"$NODES"

# Gate — every remaining role authenticates to PocketBase, so check before we
# ship code to any of them. Only the creds a listed role actually uses.
if [ "${SKIP_PB_READINESS:-}" = "1" ]; then
  echo "==> skipping PocketBase readiness check (SKIP_PB_READINESS=1)"
else
  echo "==> checking PocketBase is ready at $PB_URL"
  ok=1
  if grep -qE '^[[:space:]]*worker([[:space:]]|$)' <<<"$NODES"; then
    pb_ready worker WORKER "${WORKER_PB_USERNAME:-}" "${WORKER_PB_PASSWORD:-}" || ok=0
  fi
  if grep -qE '^[[:space:]]*evaluator([[:space:]]|$)' <<<"$NODES"; then
    pb_ready evaluator EVALUATOR "${EVALUATOR_PB_USERNAME:-}" "${EVALUATOR_PB_PASSWORD:-}" || ok=0
  fi
  # Then every non-PocketBase node individually. The credential check above shares
  # one vantage point; reachability cannot be shared, because it is exactly what
  # differs between nodes.
  while read -r role ip _; do
    case "${role:-}" in "" | \#* | pocketbase | 'NODES="' | '"') continue ;; esac
    [ -n "${ip:-}" ] || continue
    pb_route_ok "$role" "$ip" || ok=0
  done <<<"$NODES"
  # Not "before any node was touched": pass 1 above already deployed the
  # pocketbase node, which imports the schema, applies settings and installs the
  # maintenance timer. Saying otherwise invites a rollback decision based on a
  # false premise about the database node.
  [ "$ok" = "1" ] || {
    echo "Aborting before any WORKER or EVALUATOR node was touched."
    if grep -qE '^[[:space:]]*pocketbase([[:space:]]|$)' <<<"$NODES"; then
      echo "  NOTE: the pocketbase node was already deployed above — schema imported,"
      echo "  settings applied, maintenance timer installed. It is not unchanged."
    fi
    echo "  Fix the problem reported above and re-run; the pocketbase step is idempotent."
    exit 1
  }
fi

# Pass 2 — everything else, in file order.
while read -r role ip zone _; do
  case "${role:-}" in
    "" | \#* | pocketbase) continue ;;
    *) deploy_node "$role" "${ip:-}" "${zone:-}" ;;
  esac
done <<<"$NODES"

echo "All nodes deployed."
