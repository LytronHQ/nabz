#!/usr/bin/env bash
# access_test.sh — run the vendored access.sh against a stub Cloudflare API,
# driven exactly the way this repo drives it, and check the things that are
# expensive to get wrong in production.
#
#   ./deploy/cloudflare/access_test.sh
#
# `edge.sh access` itself belongs to LytronHQ/ops and is tested there. What is ours is
# the INVOCATION: which token names, which policy name, and reading the output
# back. Each of those has a production failure mode that the module cannot catch
# for us, because from its side every name is equally valid.
#
# What it asserts:
#   1. the workflow's run manages ONLY the web token, and prints it under the
#      name deploy/cloudflare/token-var.sh computes — if the module ever changed
#      that rule, every assertion below would stop matching
#   2. fly-token.sh's run mints the fly token without disturbing the web's
#   3. a re-run is idempotent, and does NOT print secrets it cannot know
#      (Cloudflare returns them only at creation)
#   4. the policy carries BOTH token ids, in ONE policy, decision=non_identity
#   5. a web-only run KEEPS the fly token in the policy, and the reverse
#   6. rotation is scoped: rotating one cannot invalidate the other
#   7. an extra policy on the application is refused, because Access ORs policies
#      and each one is another way past the service token
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# The module is fetched, not committed.
OPS="$(cd "$HERE/.." && pwd)/.ops"
"$HERE/../ops-fetch.sh" --check >/dev/null 2>&1 || "$HERE/../ops-fetch.sh" >/dev/null
STATE="$(mktemp -d)"
trap 'rm -rf "$STATE"; [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null || true' EXIT

PORT="${PORT:-18099}"
python3 "$HERE/access_stub.py" "$PORT" "$STATE" &
STUB_PID=$!
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 0.1
done

# The same names the workflow and fly-token.sh use. Hard-coded here on purpose:
# if either caller changes a name, this test should fail rather than follow it —
# a new name mints a NEW Cloudflare token and abandons the live one, whose
# secret is not retrievable.
APP="nabz-pocketbase"
WEB_TOKEN="${APP}-worker"
FLY_TOKEN="${APP}-fly-worker"
WEB_VAR="$("$HERE/token-var.sh" "$WEB_TOKEN")"
FLY_VAR="$("$HERE/token-var.sh" "$FLY_TOKEN")"

run_access() {
  printf '%s' stub | bash "$OPS/edge.sh" access \
    --api-base "http://127.0.0.1:${PORT}" --api-token-file - \
    --account-id acct --hostname pb.test.local \
    --app-name "$APP" --policy-name worker-service-token "$@" 2>/dev/null
}
web_run() { run_access --token "$WEB_TOKEN" "$@"; }   # what infra-access.yml runs
fly_run() { run_access --token "$FLY_TOKEN" "$@"; }   # what fly-token.sh runs

tokens_named() { # name-substring -> count
  python3 -c "
import json,sys
print(sum(1 for t in json.load(open('$STATE/tokens.json')).values() if '$1' in t['name']))"
}

policy_token_ids() {
  python3 -c "
import json
p = list(json.load(open('$STATE/policies.json')).values())[0]
print(' '.join(sorted(i['service_token']['token_id'] for i in p['include'])))"
}

count_of() { python3 -c "import json;print(len(json.load(open('$STATE/$1.json'))))"; }

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== the workflow's run manages ONLY the web token =="
# A CI run that minted the fly token would print its secret into a log and store
# it nowhere. Cloudflare shows that secret once, so it would be burned.
out0="$(web_run)"
grep -q "^CF_ACCESS_CLIENT_ID_${WEB_VAR}=" <<<"$out0" \
  || fail "no web client id under CF_ACCESS_CLIENT_ID_${WEB_VAR} — token-var.sh and access.sh disagree on the name"
grep -q "^CF_ACCESS_CLIENT_SECRET_${WEB_VAR}=" <<<"$out0" || fail "no web secret on first run"
grep -q "^CF_ACCESS_CLIENT_SECRET_${FLY_VAR}=" <<<"$out0" && fail "a web run minted the fly token"
[ "$(tokens_named fly)" = "0" ]    || fail "a web run created a fly service token"
[ "$(tokens_named worker)" = "1" ] || fail "expected exactly one web token"

echo "== the policy is the one this application already has =="
pname="$(python3 -c "
import json
print(list(json.load(open('$STATE/policies.json')).values())[0]['name'])")"
[ "$pname" = "worker-service-token" ] \
  || fail "policy is named '$pname', not worker-service-token — the live policy would be left behind and this one added beside it"

echo "== first fly run =="
out1="$(fly_run)"
grep -q "^CF_ACCESS_CLIENT_ID_${FLY_VAR}=" <<<"$out1"     || fail "no fly client id"
grep -q "^CF_ACCESS_CLIENT_SECRET_${FLY_VAR}=" <<<"$out1" || fail "no fly secret when minting"
grep -q "^CF_ACCESS_CLIENT_SECRET_${WEB_VAR}=" <<<"$out1" && fail "the fly run rotated the WEB token"
[ "$(count_of tokens)" = "2" ] || fail "expected 2 service tokens, got $(count_of tokens)"

echo "== second run (idempotence) =="
out2="$(fly_run)"
[ "$(count_of tokens)" = "2" ]   || fail "a re-run minted more tokens ($(count_of tokens))"
[ "$(count_of apps)" = "1" ]     || fail "a re-run created another Access application ($(count_of apps))"
[ "$(count_of policies)" = "1" ] || fail "a re-run created another policy ($(count_of policies))"
# A re-run cannot know the secrets, and must not pretend to.
grep -q "^CF_ACCESS_CLIENT_SECRET_${FLY_VAR}=" <<<"$out2" && fail "a re-run printed a secret it cannot know"
grep -q "^CF_ACCESS_CLIENT_ID_${FLY_VAR}=" <<<"$out2" || fail "a re-run must still print the client id"

echo "== policy shape =="
python3 - "$STATE" <<'PY' || fail "policy shape is wrong"
import json, sys
policies = json.load(open(sys.argv[1] + '/policies.json'))
p = list(policies.values())[0]
assert p['decision'] == 'non_identity', p['decision']
ids = sorted(i['service_token']['token_id'] for i in p['include'])
assert len(ids) == 2, ids
assert len(set(ids)) == 2, ids
PY

echo "== a web-only run keeps the fly token in the policy =="
# Otherwise a routine web rotation would lock the Fly worker out of PocketBase,
# silently, from somewhere unrelated.
before="$(policy_token_ids)"
web_run >/dev/null
after="$(policy_token_ids)"
[ "$before" = "$after" ] || fail "a web-only run changed the policy's tokens: [$before] -> [$after]"
[ "$(wc -w <<<"$after")" = "2" ] || fail "policy should still carry both tokens, has: $after"

echo "== rotation is scoped =="
out_rot="$(fly_run --rotate "$FLY_TOKEN")"
grep -q "^CF_ACCESS_CLIENT_SECRET_${FLY_VAR}=" <<<"$out_rot" || fail "--rotate did not mint a fly secret"
grep -q "^CF_ACCESS_CLIENT_SECRET_${WEB_VAR}=" <<<"$out_rot" && fail "rotating the fly token rotated the WEB token too"
[ "$(tokens_named worker)" = "2" ] || fail "rotation created or destroyed a token"

out_rot2="$(web_run --rotate "$WEB_TOKEN")"
grep -q "^CF_ACCESS_CLIENT_SECRET_${WEB_VAR}=" <<<"$out_rot2" || fail "--rotate did not rotate the web token"
grep -q "^CF_ACCESS_CLIENT_SECRET_${FLY_VAR}=" <<<"$out_rot2" && fail "rotating the web token rotated the FLY token too"
[ "$(wc -w <<<"$(policy_token_ids)")" = "2" ] || fail "rotation dropped a token from the policy"

echo "== an extra policy is refused =="
python3 - "$STATE" <<'PY'
import json, sys
path = sys.argv[1] + '/policies.json'
policies = json.load(open(path))
policies['rogue'] = {'id': 'rogue', 'name': 'a-second-door', 'decision': 'allow', 'include': []}
json.dump(policies, open(path, 'w'))
PY
if fly_run >/dev/null 2>&1; then
  fail "access.sh accepted an application with a second policy"
fi

echo "PASS"
