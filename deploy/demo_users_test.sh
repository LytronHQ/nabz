#!/usr/bin/env bash
# demo_users_test.sh — setup-pocketbase.sh's app-user step against a stub PocketBase.
#
#   ./deploy/demo_users_test.sh
#
# The demo users (admin@nabz.sh, user@nabz.sh) are seeded with a password written
# in this repo. Production seeded both on launch day, claimable by the first
# stranger to sign in (#667). Outside dev the step must create nothing and delete
# exactly those two addresses; on dev it must still seed them.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is missing: cannot test the app-user step"; exit 2; }

# The step under test, from the script itself so the test cannot drift: from the
# seeding helper to the next section.
step="$(sed -n '/^seed_app_user() {/,/^# Account emails (#627)/p' "$HERE/setup-pocketbase.sh")"
[ -n "$step" ] || fail "app-user step not found in setup-pocketbase.sh"

# A PocketBase in which both demo users exist and were never signed in to. Every
# write is logged as "METHOD URL".
mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<EOF
#!/usr/bin/env bash
method=GET url= out= fmt=
while [ \$# -gt 0 ]; do
  case "\$1" in
    -X) method="\$2"; shift 2 ;;
    -o) out="\$2"; shift 2 ;;
    -w) fmt="\$2"; shift 2 ;;
    -H|-d) shift 2 ;;
    -*) shift ;;
    *) url="\$1"; shift ;;
  esac
done
[ "\$method" = GET ] || echo "\$method \$url" >> "$WORK/calls.log"
case "\$method \$url" in
  GET*admin%40nabz.sh*|GET*user%40nabz.sh*)
    id=u1; case "\$url" in *user%40nabz.sh*) id=u2;; esac
    body="{\"items\":[{\"id\":\"\$id\",\"must_change_password\":true}]}" ; code=200 ;;
  GET*) body='{"items":[]}' code=200 ;;
  POST*) body='{}' code=200 ;;
  DELETE*) body='' code=204 ;;
esac
if [ -n "\$out" ]; then printf '%s' "\$body" > "\$out"; else printf '%s' "\$body"; fi
[ -z "\$fmt" ] || printf '%s' "\$code"
EOF
chmod +x "$WORK/bin/curl"

run() { # SEED_APP_USERS value ("" = unset)
  : > "$WORK/calls.log"
  ( export PATH="$WORK/bin:$PATH" PB_ADDR=127.0.0.1 PB_PORT=8090 TOKEN=t
    if [ -n "$1" ]; then export SEED_APP_USERS="$1"; else unset SEED_APP_USERS; fi
    eval "$step" ) > "$WORK/out.log" 2>&1 || { cat "$WORK/out.log" >&2; fail "the step exited non-zero"; }
}

# 1. Production as remote-deploy.sh configures it, and a box with no setting at all.
for setting in 0 ""; do
  run "$setting"
  grep -q '^POST ' "$WORK/calls.log" && fail "SEED_APP_USERS='$setting' created users: $(cat "$WORK/calls.log")"
  dels="$(grep -c '^DELETE ' "$WORK/calls.log" || true)"
  [ "$dels" -eq 2 ] || fail "SEED_APP_USERS='$setting' made $dels deletes, want 2: $(cat "$WORK/calls.log")"
  for id in u1 u2; do
    grep -q "records/$id\$" "$WORK/calls.log" || fail "did not delete demo user $id: $(cat "$WORK/calls.log")"
  done
done
echo "ok: outside dev no demo user is created and both are deleted"

# 2. A configured address is never deleted, even a demo-looking one.
export SEED_ADMIN_EMAIL=someone@example.com
run 0
unset SEED_ADMIN_EMAIL
grep -q 'someone' "$WORK/calls.log" && fail "a configured SEED_ADMIN_EMAIL was touched"
[ "$(grep -c '^DELETE ' "$WORK/calls.log")" -eq 2 ] || fail "with a configured SEED_ADMIN_EMAIL: $(cat "$WORK/calls.log")"
echo "ok: only the two literal demo addresses are removed"

# 3. Dev still gets its demo users and loses nothing.
run 1
grep -q '^DELETE ' "$WORK/calls.log" && fail "dev deleted users: $(cat "$WORK/calls.log")"
grep -q 'already exists' "$WORK/out.log" || fail "dev did not run the seeding: $(cat "$WORK/out.log")"
echo "ok: dev still seeds the demo users"

# 4. remote-deploy.sh turns seeding on for dev only.
# shellcheck disable=SC2016 # the pattern is the literal source line
grep -q 'kv SEED_APP_USERS *"$(\[ "$ENV_NAME" = dev \] && echo 1 || echo 0)"' "$HERE/remote-deploy.sh" \
  || fail "remote-deploy.sh does not set SEED_APP_USERS from the environment name"
echo "ok: remote-deploy.sh seeds demo users on dev only"
