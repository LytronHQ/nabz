#!/usr/bin/env bash
# infra_tunnel_workflow_test.sh — run the infra-tunnel workflow's own shell block
# against a stub Cloudflare API and a stub gh.
#
#   ./deploy/cloudflare/infra_tunnel_workflow_test.sh
#
# tunnel.sh itself belongs to LytronHQ/ops and is tested there. What is ours is
# the invocation and the parse. Two things here fail quietly rather than loudly:
#
#   - the tunnel NAME. The module defaults it to the hostname, and this tunnel is
#     named by TUNNEL_NAME. Get it wrong and the run creates a SECOND tunnel
#     beside the live one, succeeds, and stores a token for the wrong one.
#   - the TUNNEL_TOKEN parse. The token is one line of stdout among progress on
#     stderr; a parse that comes back empty is the difference between a tunnel
#     that connects and one that never does.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# The module is fetched, not committed.
OPS="$ROOT/deploy/.ops"
"$ROOT/deploy/ops-fetch.sh" --check >/dev/null 2>&1 || "$ROOT/deploy/ops-fetch.sh" >/dev/null
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null || true' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

PORT="${PORT:-18103}"
CF_STATE="$WORK/cf"; mkdir -p "$CF_STATE"
python3 "$HERE/tunnel_stub.py" "$PORT" "$CF_STATE" &
STUB_PID=$!
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 0.1
done

# --- the block, out of the real workflow ------------------------------------
# The step's env: block comes out too, for the entries the workflow sets
# LITERALLY — TUNNEL_ORIGIN above all. Supplying that from the test instead would
# make the ingress assertion a test of the test.
python3 - "$ROOT/.github/workflows/infra-tunnel.yml" "$WORK/block.sh" "$WORK/step-env.sh" <<'EXTRACT'
import shlex, sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
steps = [s for s in wf['jobs']['tunnel']['steps'] if 'run' in s and 'edge.sh tunnel' in s['run']]
assert len(steps) == 1, f"expected one step calling 'edge.sh tunnel', found {len(steps)}"
body = steps[0]['run'].replace('${{ github.repository }}', 'LytronHQ/nabz-internal')
assert '${{' not in body, f"unsubstituted Actions expression:\n{body}"
open(sys.argv[2], 'w').write("#!/usr/bin/env bash\n" + body)

literal = {k: v for k, v in (steps[0].get('env') or {}).items()
           if '${{' not in str(v)}
assert 'TUNNEL_ORIGIN' in literal, \
    "the workflow no longer sets TUNNEL_ORIGIN literally; this test asserts on its value"
with open(sys.argv[3], 'w') as f:
    for k, v in sorted(literal.items()):
        f.write(f"export {k}={shlex.quote(str(v))}\n")
EXTRACT

# --- a fixture tree the block's relative paths resolve in --------------------
mkdir -p "$WORK/repo/deploy/cloudflare" "$WORK/repo/deploy/.ops"
# The scripts under test fetch the module before using it. In a fixture that
# fetch is a no-op: the caller is what is under test here, and the real fetch
# has its own test (deploy/ops_vendor_test.sh).
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/repo/deploy/ops-fetch.sh"
chmod +x "$WORK/repo/deploy/ops-fetch.sh"

cat > "$WORK/repo/deploy/.ops/edge.sh" <<EOF
#!/usr/bin/env bash
# The action is the first argument; the stub API goes after it, so the caller
# under test passes exactly what it would in production.
action="\$1"; shift
exec "$OPS/edge.sh" "\$action" --api-base "http://127.0.0.1:${PORT}" "\$@"
EOF
chmod +x "$WORK/repo/deploy/.ops/edge.sh"

# --- a stub gh ---------------------------------------------------------------
# Exported, because the stub gh and the helpers below both read it from the
# environment rather than being handed it.
export SECRETS="$WORK/secrets.json"; echo '{}' > "$SECRETS"
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${2:-}" = "set" ] || { echo "stub gh: $*" >&2; exit 64; }
name="$3"; val=""
while [ $# -gt 0 ]; do [ "$1" = "--body" ] && { val="$2"; break; }; shift; done
python3 -c "
import json,os,sys
f=os.environ['SECRETS']
s=json.load(open(f)); s[sys.argv[1]]=sys.argv[2]
json.dump(s,open(f,'w'))" "$name" "$val"
EOF
chmod +x "$WORK/bin/gh"

stored() { python3 -c "
import json,os,sys
print(json.load(open(os.environ['SECRETS'])).get(sys.argv[1],''))" "$1"; }

run_block() { # [extra env assignments]
  # shellcheck disable=SC1090
  ( cd "$WORK/repo" && . "$WORK/step-env.sh" && env PATH="$WORK/bin:$PATH" SECRETS="$SECRETS" \
      CF_API_TOKEN=stub CF_ACCOUNT_ID=acct CF_ZONE_NAME=example.test \
      TUNNEL_HOSTNAME=pb.example.test TUNNEL_NAME=nabz-pb \
      PB_BIND_IP=10.0.0.2 GH_TOKEN=stub ENV_NAME=production "$@" \
      bash "$WORK/block.sh" ) 2>&1
}

echo "== a first run creates the tunnel and stores the token =="
out="$(run_block)" || fail "first run failed: $out"
tok="$(stored TUNNEL_TOKEN)"
[ -n "$tok" ] || fail "no TUNNEL_TOKEN stored — the parse missed it: $out"

echo "== the tunnel carries TUNNEL_NAME, not the hostname =="
python3 - "$CF_STATE" <<'PY' || fail "wrong tunnel name"
import json, sys
ts = list(json.load(open(sys.argv[1] + '/tunnels.json')).values())
assert len(ts) == 1, ts
assert ts[0]['name'] == 'nabz-pb', f"tunnel is named {ts[0]['name']!r} — a second tunnel beside the live one"
PY
tid="$(python3 -c "
import json
print(list(json.load(open('$CF_STATE/tunnels.json')).values())[0]['id'])")"
[ "$tok" = "connector-token-for-$tid" ] || fail "stored token '$tok' is not this tunnel's"

echo "== the ingress points at the container, not the host's private address =="
python3 - "$CF_STATE" <<'PY' || fail "wrong ingress"
import json, sys
cfg = list(json.load(open(sys.argv[1] + '/configs.json')).values())[0]
ing = cfg['config']['ingress']
assert ing[0]['hostname'] == 'pb.example.test', ing
assert ing[0]['service'] == 'http://pocketbase:8090', \
    f"origin is {ing[0]['service']!r}; the host's private address times out behind the firewall"
assert ing[-1]['service'] == 'http_status:404', ing
PY

echo "== DNS is a proxied CNAME to the tunnel =="
python3 - "$CF_STATE" <<'PY' || fail "wrong DNS record"
import json, sys
recs = list(json.load(open(sys.argv[1] + '/dns.json')).values())
assert len(recs) == 1, recs
r = recs[0]
assert r['type'] == 'CNAME' and r['content'].endswith('.cfargotunnel.com'), r
assert r['proxied'] is True, "unproxied would publish the tunnel address and skip Access"
PY

echo "== a re-run is idempotent and needs no --replace-dns =="
before="$(python3 -c "
import json
print(sorted(json.load(open('$CF_STATE/tunnels.json'))), sorted(json.load(open('$CF_STATE/dns.json'))))")"
out="$(run_block)" || fail "re-run failed — an idempotent re-run must not need --replace-dns: $out"
after="$(python3 -c "
import json
print(sorted(json.load(open('$CF_STATE/tunnels.json'))), sorted(json.load(open('$CF_STATE/dns.json'))))")"
[ "$before" = "$after" ] || fail "a re-run changed resources: $before -> $after"

echo "== a foreign A record stops the run, and nothing is changed =="
python3 - "$CF_STATE" <<'PY'
import json, sys
p = sys.argv[1] + '/dns.json'
recs = json.load(open(p))
recs['foreign'] = {"id": "foreign", "name": "pb.example.test", "type": "A",
                   "content": "203.0.113.9", "proxied": False}
json.dump(recs, open(p, 'w'))
PY
if out="$(run_block)"; then
  fail "overwrote a real A record without --replace-dns: $out"
fi
grep -q "replace-dns" <<<"$out" || fail "the error should name the way out: $out"
python3 - "$CF_STATE" <<'PY' || fail "the A record was touched anyway"
import json, sys
recs = json.load(open(sys.argv[1] + '/dns.json'))
assert 'foreign' in recs, "the foreign A record was deleted despite the refusal"
PY

echo "== PB_BIND_IP is an ordering gate: unset is fatal =="
if out="$(run_block PB_BIND_IP=)"; then fail "ran before the node existed"; fi
grep -q "infra-hetzner" <<<"$out" || fail "the error should point at infra-hetzner: $out"

echo "== an unset TUNNEL_NAME is fatal rather than defaulted =="
if out="$(run_block TUNNEL_NAME=)"; then
  fail "an empty TUNNEL_NAME should stop the run — the module would default it to the hostname"
fi

echo "PASS"
