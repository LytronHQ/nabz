#!/usr/bin/env bash
# replace_worker_test.sh — replace-worker.sh and the single-node mode of
# remote-deploy.sh it is built on (#418), without a fleet.
#
#   ./deploy/replace_worker_test.sh
#
# What a wrong answer here costs is a zone with no worker, or two: so this pins
#   1. preflight refuses every NODES shape it cannot replace safely, BEFORE any
#      host is contacted (a stub ssh fails the test if it is called)
#   2. the NODES swap keeps the zone, the `public` flag and every other line
#   3. the worker id and the first-check prediction match what the worker does
#      (remote-deploy's worker_env; worker/schedule.go's FNV-32a stagger)
#   4. remote-deploy.sh ONLY_HOST touches exactly one node and never deploys
#      PocketBase; NO_START reaches setup-worker; and a run WITHOUT them sends
#      the same commands as before
#   5. setup-worker.sh NO_START=1 creates the containers without starting them
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# The pure helpers, from the real script (it only runs main when executed).
# shellcheck source=replace-worker.sh
. "$HERE/replace-worker.sh"

NODES_FIXTURE='NODES="
pocketbase 10.0.0.2
evaluator  10.0.0.3
# a comment
worker     10.0.0.4 eu-central
worker     192.0.2.9 ap-southeast public
fly        nabz-worker-eu-fly eu ams
"'

echo "== preflight accepts a private and a public worker =="
[ "$(preflight_nodes "$NODES_FIXTURE" 10.0.0.4 10.0.0.40)" = "eu-central " ] || fail "private worker: got '$(preflight_nodes "$NODES_FIXTURE" 10.0.0.4 10.0.0.40)'"
[ "$(preflight_nodes "$NODES_FIXTURE" 192.0.2.9 192.0.2.99)" = "ap-southeast public" ] || fail "public worker lost its flag"

echo "== preflight refuses what it cannot replace =="
refuse() { # why old new [nodes]
  local why="$1" out
  if out="$(preflight_nodes "${4:-$NODES_FIXTURE}" "$2" "$3" 2>&1)"; then
    fail "$why: preflight accepted it ($out)"
  fi
  [ -n "$out" ] || fail "$why: refused without saying why"
}
refuse "old not in NODES"             10.0.0.99 10.0.0.40
refuse "old is the evaluator"         10.0.0.3  10.0.0.40
refuse "old is PocketBase"            10.0.0.2  10.0.0.40
refuse "old is a fly app"             nabz-worker-eu-fly 10.0.0.40
refuse "new already in NODES"         10.0.0.4  10.0.0.3
refuse "new is the other worker"      10.0.0.4  192.0.2.9
refuse "old == new"                   10.0.0.4  10.0.0.4
refuse "empty new"                    10.0.0.4  ""
refuse "a host with a space"          10.0.0.4  "10.0.0.5 x"
refuse "old listed twice"             10.0.0.4  10.0.0.40 'worker 10.0.0.4 eu
worker 10.0.0.4 us'
refuse "the free zone"                10.0.0.4  10.0.0.40 'worker 10.0.0.4 free'
refuse "a misspelt public flag"       10.0.0.4  10.0.0.40 'worker 10.0.0.4 eu pubic'
refuse "commented-out old"            10.0.0.4  10.0.0.40 '# worker 10.0.0.4 eu'
out="$(preflight_nodes "$NODES_FIXTURE" 10.0.0.3 10.0.0.40 2>&1 || true)"
grep -q "'evaluator' node" <<<"$out" || fail "refusing a non-worker should name its role: $out"

echo "== the swap changes one address and nothing else =="
swapped="$(nodes_swap "$NODES_FIXTURE" 10.0.0.4 10.0.0.40)"
want="${NODES_FIXTURE/worker     10.0.0.4 eu-central/worker 10.0.0.40 eu-central}"
[ "$swapped" = "$want" ] || fail "swap of a private worker:
want:
$want
got:
$swapped"
swapped="$(nodes_swap "$NODES_FIXTURE" 192.0.2.9 192.0.2.99)"
grep -qx 'worker 192.0.2.99 ap-southeast public' <<<"$swapped" || fail "public flag lost in the swap: $swapped"
! grep -q '192.0.2.9 ' <<<"$swapped" || fail "old address still present after the swap"
# Only a worker line is ever swapped, even if another role shares the address.
[ "$(nodes_swap 'evaluator 10.0.0.4' 10.0.0.4 10.0.0.40)" = 'evaluator 10.0.0.4' ] || fail "swapped a non-worker line"

echo "== the derived worker id is remote-deploy's =="
worker_env_fn="$(sed -n '/^worker_env() {/,/^}/p' "$HERE/remote-deploy.sh")"
[ -n "$worker_env_fn" ] || fail "worker_env not found in remote-deploy.sh"
rd_id="$(bash -c "
  PB_URL=x PB_AUTH_COLLECTION=x WORKER_PB_USERNAME=u WORKER_PB_PASSWORD=p BUILD_VERSION=v BUILD_COMMIT=c ENV_FILE=t
  $worker_env_fn
  worker_env eu-central 10.0.0.4" | sed -n 's/^WORKER_ID=//p')"
[ "$rd_id" = "$(derived_worker_id eu-central 10.0.0.4)" ] || fail "id mismatch: remote-deploy '$rd_id' vs '$(derived_worker_id eu-central 10.0.0.4)'"

echo "== FNV-32a matches the reference vectors =="
# http://www.isthe.com/chongo/tech/comp/fnv/ test vectors for FNV-1a 32.
[ "$(fnv1a32 '')" = 2166136261 ] || fail "fnv1a32('') = $(fnv1a32 '')"
[ "$(fnv1a32 a)" = 3826002220 ] || fail "fnv1a32(a) = $(fnv1a32 a)"           # 0xe40c292c
[ "$(fnv1a32 foobar)" = 3214735720 ] || fail "fnv1a32(foobar) = $(fnv1a32 foobar)" # 0xbf9cf968
# And it is still the hash the worker uses.
grep -q 'fnv.New32a()' "$HERE/../worker/schedule.go" || fail "worker/schedule.go no longer uses FNV-32a; update fnv1a32"
grep -q 'hashId(id) % uint32(interval)' "$HERE/../worker/schedule.go" || fail "worker/schedule.go startupOffset changed; update first_check_offset"

echo "== first-check prediction follows the worker's rules =="
mons='{"items":[
 {"id":"hb0000000000001","type":"heartbeat","interval":30,"zones":[]},
 {"id":"other0000000001","type":"website","interval":30,"zones":["us"]},
 {"id":"allzones0000001","type":"website","interval":0,"zones":[]},
 {"id":"eu0000000000001","type":"website","interval":10,"zones":["eu","us"]},
 {"id":"eu0000000000002","type":"port","interval":300,"zones":["eu"]}]}'
exp=""
for pair in allzones0000001:60 eu0000000000001:30 eu0000000000002:300; do
  o=$(( $(fnv1a32 "${pair%%:*}") % ${pair##*:} ))
  if [ -z "$exp" ] || [ "$o" -lt "$exp" ]; then exp=$o; fi
done
got="$(first_check_offset eu <<<"$mons")"
[ "$got" = "$exp" ] || fail "first_check_offset eu: want $exp, got '$got'"
[ -z "$(first_check_offset eu <<<'{"items":[{"id":"hb0000000000001","type":"heartbeat","interval":30,"zones":[]}]}')" ] \
  || fail "a zone with only heartbeat monitors should predict no check"
[ -z "$(first_check_offset eu <<<'{"items":[]}')" ] || fail "an empty zone should predict no check"

echo "== heartbeat rows are picked by exact worker id =="
# The first lab run deleted nothing: the ids were joined with "$(printf '\n')",
# which is empty, so no row matched and the old worker stayed in the roster for
# its whole TTL. This pins the join the script now uses, and exact matching.
rows='{"items":[
 {"id":"r1","worker":"eu-10-0-0-4","updated":"2026-10-12 10:00:01.000Z"},
 {"id":"r2","worker":"eu-10-0-0-4-2","updated":"2026-10-12 10:00:05.000Z"},
 {"id":"r3","worker":"eu-10-0-0-40","updated":"2026-10-12 10:00:09.000Z"},
 {"id":"r4","worker":"eu-10-0-0-5","updated":"2026-10-12 10:00:03.000Z"}]}'
old_ids=$'eu-10-0-0-4\neu-10-0-0-4-2'
got="$(heartbeat_rows "$old_ids"$'\n'"eu-10-0-0-40" <<<"$rows" | cut -f1 | tr '\n' ' ')"
[ "$got" = "r1 r2 r3 " ] || fail "old+new ids: want 'r1 r2 r3 ', got '$got'"
got="$(heartbeat_rows "$old_ids" <<<"$rows" | cut -f1 | tr '\n' ' ')"
[ "$got" = "r1 r2 " ] || fail "a prefix matched as well as the exact id: '$got'"
[ "$(heartbeat_rows "$old_ids" <<<"$rows" | cut -f3 | sort | tail -1)" = "2026-10-12 10:00:05.000Z" ] \
  || fail "old last beat is not the latest of the old rows"
[ -z "$(heartbeat_rows $'\n' <<<"$rows")" ] || fail "blank ids matched rows"

echo "== os detection =="
os_is_debian_like "ubuntu debian" || fail "ubuntu refused"
os_is_debian_like "debian " || fail "debian refused"
os_is_debian_like "pop ubuntu debian" || fail "an ubuntu derivative refused"
! os_is_debian_like "rocky rhel centos fedora" || fail "rocky accepted"
! os_is_debian_like "alpine " || fail "alpine accepted"

# --- whole-script runs, against stub ssh -------------------------------------
# A copy of the deploy dir in a scratch repo, with a stub `ssh` that records every
# host and command it is given and never connects anywhere.
mkdir -p "$WORK/repo/deploy/.ops" "$WORK/bin"
cp "$HERE/remote-deploy.sh" "$HERE/replace-worker.sh" "$HERE/setup-worker.sh" \
   "$HERE/setup-evaluator.sh" "$HERE/setup-pocketbase.sh" "$WORK/repo/deploy/"
printf '#!/bin/sh\nexit 0\n' > "$WORK/repo/deploy/ops-fetch.sh"
chmod +x "$WORK/repo/deploy/"*.sh
echo 0.0.0 > "$WORK/repo/VERSION"
# An index is all push_code needs (git ls-files); no commit, so BUILD_COMMIT is
# "unknown", which remote-deploy already allows for.
git -C "$WORK/repo" init -q && git -C "$WORK/repo" add -A
cat > "$WORK/bin/ssh" <<'STUB'
#!/usr/bin/env bash
# Last two args are user@host and the remote command.
host="${@: -2:1}"; cmd="${@: -1}"
printf '%s\t%s\n' "${host#*@}" "$cmd" >> "$SSH_LOG"
cat >/dev/null
exit 0
STUB
chmod +x "$WORK/bin/ssh"
cat > "$WORK/repo/deploy/t.env" <<'ENV'
SSH_KEY=/dev/null
SSH_USER=dev
PB_URL=http://10.0.0.2:8090
PB_SUPERUSER_EMAIL=su@t
PB_SUPERUSER_PASSWORD=supw
WORKER_PB_USERNAME=w@t
WORKER_PB_PASSWORD=wpw
EVALUATOR_PB_USERNAME=e@t
EVALUATOR_PB_PASSWORD=epw
ENV
LAB_NODES='pocketbase 10.0.0.2
evaluator 10.0.0.3
worker 10.0.0.4 eu
worker 10.0.0.5 eu'
export SSH_LOG="$WORK/ssh.log"

rd() { # env-assignments… — run the copied remote-deploy.sh against the stub
  : > "$SSH_LOG"
  env PATH="$WORK/bin:$PATH" NODES="$LAB_NODES" "$@" bash "$WORK/repo/deploy/remote-deploy.sh" t
}
hosts() { cut -f1 "$SSH_LOG" | sort -u | tr '\n' ' '; }

echo "== remote-deploy without ONLY_HOST: every node, same commands as before =="
rd >"$WORK/out" 2>&1 || fail "full stub deploy failed: $(cat "$WORK/out")"
[ "$(hosts)" = "10.0.0.2 10.0.0.3 10.0.0.4 10.0.0.5 " ] || fail "full deploy touched: $(hosts)"
grep -q "$(printf '^10.0.0.2\tsudo SKIP_CLONE=1 bash -s$')" "$SSH_LOG" || fail "pocketbase setup command changed"
[ "$(grep -c "$(printf '\tsudo SKIP_CLONE=1 bash -s$')" "$SSH_LOG")" = 4 ] || fail "setup commands changed: $(cut -f2 "$SSH_LOG" | grep SKIP_CLONE)"
! grep -q NO_START "$SSH_LOG" || fail "NO_START leaked into a normal deploy"
grep -qx 'All nodes deployed.' "$WORK/out" || fail "final line changed"

echo "== ONLY_HOST deploys one worker, never PocketBase =="
rd ONLY_HOST=10.0.0.5 >"$WORK/out" 2>&1 || fail "ONLY_HOST deploy failed: $(cat "$WORK/out")"
# 10.0.0.2 is still contacted, read-only: it is where the credential check runs.
[ "$(hosts)" = "10.0.0.2 10.0.0.5 " ] || fail "ONLY_HOST touched: $(hosts)"
! grep -q "$(printf '^10.0.0.2\t.*SKIP_CLONE')" "$SSH_LOG" || fail "ONLY_HOST ran setup-pocketbase"
! grep -q "$(printf '^10.0.0.2\t.*tee /etc/monitors')" "$SSH_LOG" || fail "ONLY_HOST pushed an env file to PocketBase"
grep -q "$(printf '^10.0.0.5\tsudo SKIP_CLONE=1 bash -s$')" "$SSH_LOG" || fail "the one worker was not set up"
grep -q 'readiness: worker account' "$WORK/out" || fail "worker credentials were not checked"
! grep -q 'readiness: evaluator' "$WORK/out" || fail "evaluator credentials were checked for a worker-only deploy"

echo "== ONLY_HOST + NO_START reaches setup-worker =="
rd ONLY_HOST=10.0.0.5 NO_START=1 >"$WORK/out" 2>&1 || fail "NO_START deploy failed: $(cat "$WORK/out")"
grep -q "$(printf '^10.0.0.5\tsudo SKIP_CLONE=1 NO_START=1 bash -s$')" "$SSH_LOG" || fail "NO_START not forwarded: $(cat "$SSH_LOG")"

echo "== ONLY_HOST refusals touch nothing =="
for bad in "ONLY_HOST=10.0.0.2" "ONLY_HOST=10.0.0.99" "NO_START=1" "ONLY_HOST=10.0.0.3 NO_START=1"; do
  # shellcheck disable=SC2086
  if rd $bad >"$WORK/out" 2>&1; then fail "remote-deploy accepted $bad"; fi
  [ ! -s "$SSH_LOG" ] || fail "$bad contacted a host before refusing: $(cat "$SSH_LOG")"
done
rd ONLY_HOST=10.0.0.2 >"$WORK/out" 2>&1 || true
grep -qi 'pocketbase' "$WORK/out" || fail "refusing the pocketbase node should say so: $(cat "$WORK/out")"
rd ONLY_HOST=10.0.0.3 >"$WORK/out" 2>&1 || fail "ONLY_HOST on the evaluator failed: $(cat "$WORK/out")"
[ "$(hosts)" = "10.0.0.2 10.0.0.3 " ] || fail "ONLY_HOST evaluator touched: $(hosts)"

echo "== replace-worker refuses before contacting any host =="
rw() { : > "$SSH_LOG"; env PATH="$WORK/bin:$PATH" NODES="$LAB_NODES" "$@"; }
for args in "t 10.0.0.9 10.0.0.6" "t 10.0.0.3 10.0.0.6" "t 10.0.0.4 10.0.0.5" "t 10.0.0.4"; do
  # shellcheck disable=SC2086
  if rw bash "$WORK/repo/deploy/replace-worker.sh" $args >"$WORK/out" 2>&1; then fail "replace-worker accepted: $args"; fi
  [ ! -s "$SSH_LOG" ] || fail "replace-worker $args contacted a host before refusing: $(cat "$SSH_LOG")"
done
if rw VERIFY_SECONDS=90 bash "$WORK/repo/deploy/replace-worker.sh" t 10.0.0.4 10.0.0.6 >"$WORK/out" 2>&1; then
  fail "a verify deadline at the dead-man threshold was accepted"
fi
grep -q DEADMAN_SECONDS "$WORK/out" || fail "the deadline refusal should name DEADMAN_SECONDS: $(cat "$WORK/out")"
[ ! -s "$SSH_LOG" ] || fail "the deadline refusal contacted a host"

echo "== setup-worker NO_START=1 creates without starting =="
up="$(sed -n '/^if \[ "\${NO_START:-0}" = "1" \]; then$/,/^echo "   worker replicas: \$REPLICAS"$/p' "$HERE/setup-worker.sh")"
[ -n "$up" ] || fail "could not find the NO_START block in setup-worker.sh"
docker_log="$WORK/docker.log"
run_up() { env "$@" bash -c 'docker() { echo "$*" >> "'"$docker_log"'"; }; ENV_FILE=/x; PROFILES=(); REPLICAS=1; '"$up"; }
: > "$docker_log"; run_up NO_START=1 >/dev/null
grep -q -- 'up --no-start --build' "$docker_log" || fail "NO_START=1 did not use --no-start: $(cat "$docker_log")"
! grep -q -- ' -d ' "$docker_log" || fail "NO_START=1 still started detached: $(cat "$docker_log")"
: > "$docker_log"; run_up >/dev/null
grep -q -- 'up -d --build --remove-orphans' "$docker_log" || fail "the normal path changed: $(cat "$docker_log")"

echo "PASS: replace_worker_test.sh"
