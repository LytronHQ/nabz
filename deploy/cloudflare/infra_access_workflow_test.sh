#!/usr/bin/env bash
# infra_access_workflow_test.sh — run the infra-access workflow's own shell block
# against a stub Cloudflare API and a stub gh.
#
#   ./deploy/cloudflare/infra_access_workflow_test.sh
#
# This block is the one place a mistake costs a credential rather than a re-run:
# Cloudflare returns a service-token secret exactly once, so a parse that misses
# it burns the token, and a "success" that stored only half the pair breaks
# deploy-web several minutes later pointing at itself. There is no way to
# exercise it on a runner without spending the secret, so it is exercised here —
# the real YAML, extracted and executed, not a copy of its logic.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# The module is fetched, not committed.
OPS="$ROOT/deploy/.ops"
"$ROOT/deploy/ops-fetch.sh" --check >/dev/null 2>&1 || "$ROOT/deploy/ops-fetch.sh" >/dev/null
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null || true' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

PORT="${PORT:-18101}"
CF_STATE="$WORK/cf"; mkdir -p "$CF_STATE"
python3 "$HERE/access_stub.py" "$PORT" "$CF_STATE" &
STUB_PID=$!
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 0.1
done

# --- the block, out of the real workflow ------------------------------------
python3 - "$ROOT/.github/workflows/infra-access.yml" "$WORK/block.sh" <<'PY'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
steps = wf['jobs']['access']['steps']
run = [s for s in steps if 'run' in s]
assert len(run) == 1, f"expected one run step, found {len(run)}"
body = run[0]['run'].replace('${{ github.repository }}', 'LytronHQ/nabz-internal')
assert '${{' not in body, f"unsubstituted Actions expression left in the block:\n{body}"
open(sys.argv[2], 'w').write("#!/usr/bin/env bash\n" + body)
PY

# --- a fixture tree the block's relative paths resolve in --------------------
mkdir -p "$WORK/repo/deploy/cloudflare" "$WORK/repo/deploy/.ops"
# The scripts under test fetch the module before using it. In a fixture that
# fetch is a no-op: the caller is what is under test here, and the real fetch
# has its own test (deploy/ops_vendor_test.sh).
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/repo/deploy/ops-fetch.sh"
chmod +x "$WORK/repo/deploy/ops-fetch.sh"

ln -s "$HERE/token-var.sh" "$WORK/repo/deploy/cloudflare/token-var.sh"
# access.sh reads nothing from the environment, so the stub API is injected by a
# shim rather than by a hook in the workflow. exec keeps stdin — the API token.
cat > "$WORK/repo/deploy/.ops/edge.sh" <<EOF
#!/usr/bin/env bash
# The action is the first argument; the stub API goes after it, so the caller
# under test passes exactly what it would in production.
action="\$1"; shift
exec "$OPS/edge.sh" "\$action" --api-base "http://127.0.0.1:${PORT}" "\$@"
EOF
chmod +x "$WORK/repo/deploy/.ops/edge.sh"

# --- a stub gh ---------------------------------------------------------------
SECRETS="$WORK/secrets.json"; echo '{}' > "$SECRETS"
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
# gh secret set <NAME> --env E --repo R --body V | gh secret list --env E --repo R --json name -q …
set -euo pipefail
[ "${FAIL_WRITES:-0}" = "1" ] && [ "${2:-}" = "set" ] && { echo "gh: forbidden" >&2; exit 1; }
case "${2:-}" in
  set)
    name="$3"; val=""
    while [ $# -gt 0 ]; do [ "$1" = "--body" ] && { val="$2"; break; }; shift; done
    python3 -c "
import json,os,sys
f=os.environ['SECRETS']
s=json.load(open(f)); s[sys.argv[1]]=sys.argv[2]
json.dump(s,open(f,'w'))" "$name" "$val" ;;
  list)
    python3 -c "
import json,os
print('\n'.join(json.load(open(os.environ['SECRETS'])).keys()))" ;;
  *) echo "stub gh: unhandled: $*" >&2; exit 64 ;;
esac
EOF
chmod +x "$WORK/bin/gh"

stored() { python3 -c "
import json,sys
print(json.load(open('$SECRETS')).get(sys.argv[1],''))" "$1"; }

forget() { python3 -c "
import json,sys
s=json.load(open('$SECRETS')); s.pop(sys.argv[1],None)
json.dump(s,open('$SECRETS','w'))" "$1"; }

run_block() { # ROTATE=0|1 [extra env assignments]
  local rotate="$1"; shift
  # ROTATE_PUBLIC_WORKER defaults to 0 like the workflow's input; an assignment in
  # "$@" comes after it, so a caller can still set it.
  ( cd "$WORK/repo" && env PATH="$WORK/bin:$PATH" ROTATE_PUBLIC_WORKER=0 "$@" \
      SECRETS="$SECRETS" \
      CF_API_TOKEN=stub CF_ACCOUNT_ID=acct ACCESS_HOSTNAME=pb.test.local \
      APP_NAME=nabz-pocketbase ROTATE="$rotate" GH_TOKEN=stub ENV_NAME=production \
      bash "$WORK/block.sh" ) 2>&1
}

echo "== a first run stores BOTH halves =="
out="$(run_block 0)" || fail "first run failed: $out"
id="$(stored CF_ACCESS_CLIENT_ID)"
[ -n "$id" ]                              || fail "no CF_ACCESS_CLIENT_ID stored — the workflow's parse missed the module's output name"
[ -n "$(stored CF_ACCESS_CLIENT_SECRET)" ] || fail "no CF_ACCESS_CLIENT_SECRET stored; a burned token: $out"

# The id has to be the real one, not a truncation or a neighbouring line.
real_id="$(python3 -c "
import json
ts=json.load(open('$CF_STATE/tokens.json'))
print([t['client_id'] for t in ts.values() if t['name']=='nabz-pocketbase-worker'][0])")"
[ "$id" = "$real_id" ] || fail "stored client id '$id' is not the token's '$real_id'"

echo "== the public workers get their own pair (#498) =="
[ -n "$(stored WORKER_CF_ACCESS_CLIENT_ID)" ]     || fail "no WORKER_CF_ACCESS_CLIENT_ID stored: $out"
[ -n "$(stored WORKER_CF_ACCESS_CLIENT_SECRET)" ] || fail "no WORKER_CF_ACCESS_CLIENT_SECRET stored — a burned token: $out"
real_pid="$(python3 -c "
import json
ts=json.load(open('$CF_STATE/tokens.json'))
print([t['client_id'] for t in ts.values() if t['name']=='nabz-pocketbase-public-worker'][0])")"
[ "$(stored WORKER_CF_ACCESS_CLIENT_ID)" = "$real_pid" ] || fail "stored public-worker id is not that token's"
[ "$(stored WORKER_CF_ACCESS_CLIENT_ID)" != "$id" ] || fail "the public workers share the web's token — revoking one would cut off both"

echo "== the tokens and policy are the live ones, by name =="
python3 - "$CF_STATE" <<'PY' || fail "wrong token or policy name"
import json, sys
names = sorted(t['name'] for t in json.load(open(sys.argv[1] + '/tokens.json')).values())
assert names == ['nabz-pocketbase-public-worker', 'nabz-pocketbase-worker'], names
pols = list(json.load(open(sys.argv[1] + '/policies.json')).values())
# ONE policy carrying both tokens: Access ORs policies, so a second one would be a
# second way in.
assert len(pols) == 1, pols
assert pols[0]['name'] == 'worker-service-token', pols[0]['name']
# ...and that one policy admits BOTH tokens: the second access.sh call must keep
# the first token rather than replace it, or minting the public workers' token
# locks the web app out.
tokens = json.load(open(sys.argv[1] + '/tokens.json')).values()
want = sorted(t['id'] for t in tokens)
got = sorted(i['service_token']['token_id'] for i in pols[0]['include'] if 'service_token' in i)
assert got == want, (got, want)
PY

echo "== a re-run reuses, and does not claim a secret it cannot know =="
before="$(stored CF_ACCESS_CLIENT_SECRET)"
out="$(run_block 0)" || fail "re-run failed: $out"
grep -q "unchanged" <<<"$out" || fail "a re-run should say the stored secret is unchanged: $out"
[ "$(stored CF_ACCESS_CLIENT_SECRET)" = "$before" ] || fail "a re-run overwrote the stored secret"

echo "== reuse with nothing stored is fatal, not a quiet half-write =="
forget CF_ACCESS_CLIENT_SECRET
if out="$(run_block 0)"; then
  fail "reported success with no stored secret — deploy-web would fail later, pointing at itself"
fi
grep -q "rotate_token" <<<"$out" || fail "the error should name the way out (rotate_token=true): $out"

echo "== rotate mints and stores a fresh pair =="
out="$(run_block 1)" || fail "rotate run failed: $out"
new_secret="$(stored CF_ACCESS_CLIENT_SECRET)"
[ -n "$new_secret" ]        || fail "rotate stored no secret — the minted one is gone for good"
[ "$new_secret" != "$before" ] || fail "rotate stored the old secret"
# Pins the shape the leak check below searches for. Without this the needle
# there is an assumption, and an assumption that drifts matches nothing.
case "$new_secret" in
  rotated-*) ;;
  *) fail "expected the stub's rotated secret to look like 'rotated-<id>', got '$new_secret'" ;;
esac

echo "== a failed store is fatal, and does not leak the secret into the log =="
# gh can fail: a PAT expires, an environment is renamed. Cloudflare has already
# minted the secret by then, so a step that reports success stores nothing and
# burns it. It must fail instead — and NOT by echoing the value: an Actions log
# is readable and downloadable by everyone with read access to the repository.
# One re-run with rotate_token=true is the cheaper of the two.
forget CF_ACCESS_CLIENT_SECRET
if out="$(run_block 1 FAIL_WRITES=1)"; then
  fail "reported success although the secret could not be stored — the token is burned: $out"
fi
grep -q "rotate_token=true" <<<"$out" || fail "the error should name the way out: $out"
grep -q "could not store CF_ACCESS_CLIENT_SECRET" <<<"$out" \
  || fail "the failure should say which secret could not be stored: $out"
# The stub hands a secret back without storing it, exactly as Cloudflare does, so
# what it would have been is reconstructed here rather than read: "secret-<id>"
# at creation and "rotated-<id>" on a rotate. Without this the check has no teeth
# — an empty needle matches nothing and the assertion always passes.
tid="$(python3 -c "
import json
ts=json.load(open('$CF_STATE/tokens.json'))
print(next(t['id'] for t in ts.values() if t['name']=='nabz-pocketbase-worker'))")"
[ -n "$tid" ] || fail "could not find the web token in the stub's state"
for needle in "secret-$tid" "rotated-$tid"; do
  grep -qF "$needle" <<<"$out" && fail "the service-token secret was echoed into the log"
done

echo "PASS"
