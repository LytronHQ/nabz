#!/usr/bin/env bash
# fly_token_test.sh — exercise fly-token.sh against a stub Cloudflare API and a
# stub Bitwarden CLI.
#
#   ./deploy/cloudflare/fly_token_test.sh
#
# The properties worth protecting, all of them about not destroying a credential
# Cloudflare will only ever show once:
#   1. a first run mints the fly token and stores BOTH halves in Bitwarden
#   2. a re-run reuses the token and leaves the stored secret alone
#   3. a reuse with nothing stored FAILS loudly instead of reporting success on a
#      half-written pair
#   4. ROTATE_FLY_TOKEN mints a fresh pair and stores it
#   5. a Bitwarden write failure PRINTS the credential and exits non-zero, so the
#      token can still be stored by hand rather than being burned
#   6. none of it ever rotates the web token
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# The module is fetched, not committed.
OPS="$(cd "$HERE/.." && pwd)/.ops"
"$HERE/../ops-fetch.sh" --check >/dev/null 2>&1 || "$HERE/../ops-fetch.sh" >/dev/null
WORK="$(mktemp -d)"
PORT="${PORT:-18098}"
trap 'rm -rf "$WORK"; [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null || true' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

CF_STATE="$WORK/cf"; mkdir -p "$CF_STATE"
python3 "$HERE/access_stub.py" "$PORT" "$CF_STATE" &
STUB_PID=$!
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 0.1
done

# --- a fixture deploy/ tree -------------------------------------------------
# The real scripts, reached through symlinks so they resolve their siblings here
# instead of in the repo: no test state ever lands in deploy/.
FIX="$WORK/deploy"
mkdir -p "$FIX/cloudflare" "$FIX/environments" "$FIX/.ops"
# The scripts under test fetch the module before using it. In a fixture that
# fetch is a no-op: the caller is what is under test here, and the real fetch
# has its own test (deploy/ops_vendor_test.sh).
printf '#!/usr/bin/env bash\nexit 0\n' > "$FIX/ops-fetch.sh"
chmod +x "$FIX/ops-fetch.sh"

ln -s "$HERE/fly-token.sh" "$FIX/cloudflare/fly-token.sh"
# access.sh takes the API base as a flag and reads nothing from the environment,
# so the stub is injected by a shim here rather than by a hook in fly-token.sh.
# exec keeps stdin intact — that is how the API token gets in.
cat > "$FIX/.ops/edge.sh" <<EOF
#!/usr/bin/env bash
# The action is the first argument; the stub API goes after it, so the caller
# under test passes exactly what it would in production.
action="\$1"; shift
exec "$OPS/edge.sh" "\$action" --api-base "http://127.0.0.1:${PORT}" "\$@"
EOF
chmod +x "$FIX/.ops/edge.sh"
ln -s "$HERE/token-var.sh" "$FIX/cloudflare/token-var.sh"
touch "$FIX/resolve-token.sh"
cat > "$FIX/environments/testenv.vars" <<EOF
BWS_PROJECT_ID=proj-test
PB_HOSTNAME=pb.test.local
ACCESS_APP_NAME=nabz-test-pb
EOF
# bws-env.sh is stubbed: what it returns is Bitwarden's business, and the real one
# is already exercised by every deploy.
cat > "$FIX/bws-env.sh" <<'EOF'
#!/usr/bin/env bash
echo "CF_API_TOKEN='stub-token'"
echo "CF_ACCOUNT_ID='acct'"
echo "PB_HOSTNAME='pb.test.local'"
echo "ACCESS_APP_NAME='nabz-test-pb'"
EOF
chmod +x "$FIX/bws-env.sh"

# --- a stub bws -------------------------------------------------------------
BWS_STATE="$WORK/bws.json"; echo '[]' > "$BWS_STATE"
mkdir -p "$WORK/bin"
cat > "$WORK/bin/bws" <<'EOF'
#!/usr/bin/env bash
# bws secret list <project> --output json | create <K> <V> <P> | edit --value <V> <ID>
[ "${FAIL_WRITES:-0}" = "1" ] && [ "$2" != "list" ] && { echo "forbidden" >&2; exit 1; }
case "$2" in
  list)   cat "$BWS_STATE" ;;
  create) python3 -c "
import json,sys,uuid
s=json.load(open('$BWS_STATE'))
s.append({'id':uuid.uuid4().hex,'key':sys.argv[1],'value':sys.argv[2]})
json.dump(s,open('$BWS_STATE','w'))" "$3" "$4" ;;
  edit)   python3 -c "
import json,sys
s=json.load(open('$BWS_STATE'))
for r in s:
    if r['id']==sys.argv[2]: r['value']=sys.argv[1]
json.dump(s,open('$BWS_STATE','w'))" "$4" "$5" ;;
esac
EOF
chmod +x "$WORK/bin/bws"

stored() { python3 -c "
import json
s=json.load(open('$BWS_STATE'))
print(next((r['value'] for r in s if r['key']=='$1'), ''))"; }

run_fly() {
  env PATH="$WORK/bin:$PATH" BWS_STATE="$BWS_STATE" BWS_ACCESS_TOKEN=mine "$@" \
    bash "$FIX/cloudflare/fly-token.sh" testenv 2>"$WORK/err"
}

web_token_secret_minted() { grep -c '^CF_ACCESS_CLIENT_SECRET=' "$WORK/out" || true; }

echo "== first run mints and stores =="
run_fly > "$WORK/out" || fail "first run failed: $(cat "$WORK/err")"
[ -n "$(stored FLY_CF_ACCESS_CLIENT_ID)" ]     || fail "client id not stored"
[ -n "$(stored FLY_CF_ACCESS_CLIENT_SECRET)" ] || fail "client secret not stored"
first_secret="$(stored FLY_CF_ACCESS_CLIENT_SECRET)"
# A successful store must NOT dump the credential to stdout.
grep -q 'FLY_CF_ACCESS_CLIENT_SECRET=' "$WORK/out" && fail "printed the secret after storing it successfully"

echo "== a re-run reuses and leaves the stored secret alone =="
run_fly > "$WORK/out" || fail "re-run failed: $(cat "$WORK/err")"
[ "$(stored FLY_CF_ACCESS_CLIENT_SECRET)" = "$first_secret" ] || fail "a re-run overwrote the stored secret"

echo "== reuse with nothing stored is fatal =="
python3 -c "
import json
s=[r for r in json.load(open('$BWS_STATE')) if r['key']!='FLY_CF_ACCESS_CLIENT_SECRET']
json.dump(s,open('$BWS_STATE','w'))"
if run_fly > "$WORK/out"; then
  fail "reported success with no stored secret and no way to recover one"
fi
grep -q 'ROTATE_FLY_TOKEN=1' "$WORK/err" || fail "did not say how to recover"

echo "== ROTATE_FLY_TOKEN mints and stores a fresh pair =="
run_fly ROTATE_FLY_TOKEN=1 > "$WORK/out" || fail "rotation failed: $(cat "$WORK/err")"
rotated="$(stored FLY_CF_ACCESS_CLIENT_SECRET)"
[ -n "$rotated" ] || fail "rotation stored no secret"
[ "$rotated" != "$first_secret" ] || fail "rotation stored the old secret"

echo "== the web token is left alone =="
# The web token belongs to the infra-access workflow. This script must neither
# create one — a secret minted here is printed into a laptop terminal and stored
# nowhere, and Cloudflare shows it once — nor rotate the live one, which would
# take the web Worker down from a command about Fly.
#
# So: plant a web token the way the workflow would, then run this script and
# check it is byte-for-byte the same token afterwards, and still in the policy.
web_token_state() { python3 -c "
import json
ts = json.load(open('$CF_STATE/tokens.json'))
web = sorted((t['id'], t['name']) for t in ts.values()
             if 'worker' in t['name'] and 'fly' not in t['name'])
pol = list(json.load(open('$CF_STATE/policies.json')).values())[0]
ids = sorted(i['service_token']['token_id'] for i in pol['include'])
print(web, [i for i in ids if any(i == w[0] for w in web)])"; }

printf '%s' stub-token | "$OPS/edge.sh" access --api-base "http://127.0.0.1:${PORT}" \
  --api-token-file - --account-id acct --hostname pb.test.local \
  --app-name nabz-test-pb --policy-name worker-service-token \
  --token nabz-test-pb-worker >/dev/null 2>&1 \
  || fail "could not plant a web token for the test"
before="$(web_token_state)"
[ "$before" != "[] []" ] || fail "the planted web token did not land"

run_fly > "$WORK/out" || fail "run with a web token present failed: $(cat "$WORK/out")"
grep -q '^CF_ACCESS_CLIENT_SECRET_NABZ_TEST_PB_WORKER=' "$WORK/out" \
  && fail "rotated the web token"
after="$(web_token_state)"
[ "$before" = "$after" ] || fail "the web token changed: $before -> $after"

echo "== a Bitwarden write failure prints the credential =="
python3 -c "
import json
json.dump([], open('$BWS_STATE','w'))"
if run_fly FAIL_WRITES=1 ROTATE_FLY_TOKEN=1 > "$WORK/out"; then
  fail "reported success although the Bitwarden write failed"
fi
grep -q '^FLY_CF_ACCESS_CLIENT_SECRET=' "$WORK/out" \
  || fail "the minted secret was swallowed — Cloudflare will not show it again"

echo "PASS"
