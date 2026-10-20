#!/usr/bin/env bash
# provision_test.sh — run the real provision.sh against a stub Hetzner API.
#
#   ./deploy/hetzner/provision_test.sh
#
# What it pins down is the Singapore worker (#498), because every way of getting
# it wrong surfaces only on a production run, after the EU servers already exist:
#   1. it is created as its own type (cpx02 — no cx type is sold in sin)
#   2. it is created with NO private network and NO placement group (Hetzner
#      refuses a network from another network zone)
#   3. it is never sent to attach_to_network, the backstop for EU nodes
#   4. NODES lists it as `worker <ip> ap-southeast public`, and the EU worker
#      without the marker
#   5. a server that already exists is adopted, not created again, and still
#      gets the marker
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null || true' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

PORT="${PORT:-18111}"
python3 "$HERE/hetzner_stub.py" "$PORT" "$WORK" &
STUB_PID=$!
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:${PORT}/v1/health" >/dev/null 2>&1 && break
  sleep 0.1
done

ssh-keygen -q -t ed25519 -N '' -f "$WORK/key" >/dev/null

state() { python3 -c "import json,sys; s=json.load(open('$WORK/state.json')); print(eval(sys.argv[1]))" "$1"; }

run() {
  HCLOUD_API="http://127.0.0.1:${PORT}/v1" HCLOUD_TOKEN=stub \
    SSH_PRIVATE_KEY="$(cat "$WORK/key")" ENVIRONMENT=production \
    bash "$HERE/provision.sh" 2>&1
}

echo "== a cold run creates the fleet, Singapore without the private network =="
out="$(run)" || fail "provision.sh failed: $out"

sin_type="$(state "[x['server_type']['name'] for x in s['servers'] if x['name']=='nabz-worker-ap-southeast-1']")"
[ "$sin_type" = "['cpx02']" ] || fail "Singapore worker type: want ['cpx02'], got $sin_type"
eu_type="$(state "[x['server_type']['name'] for x in s['servers'] if x['name']=='nabz-worker-eu-central-1']")"
[ "$eu_type" = "['cx23']" ] || fail "EU worker type: want ['cx23'] (SERVER_TYPE default), got $eu_type"

body="$(state "[r['body'] for r in s['requests'] if r['path']=='/servers' and r['body']['name']=='nabz-worker-ap-southeast-1'][0]")"
grep -q "'networks'" <<<"$body" && fail "Singapore worker was created WITH a network: $body"
grep -q "'placement_group'" <<<"$body" && fail "Singapore worker was put in the EU placement group: $body"
eu_body="$(state "[r['body'] for r in s['requests'] if r['path']=='/servers' and r['body']['name']=='nabz-worker-eu-central-1'][0]")"
grep -q "'networks'" <<<"$eu_body" || fail "EU worker lost its private network: $eu_body"

sin_id="$(state "[x['id'] for x in s['servers'] if x['name']=='nabz-worker-ap-southeast-1'][0]")"
attaches="$(state "len([r for r in s['requests'] if r['path']=='/servers/$sin_id/actions/attach_to_network'])")"
[ "$attaches" = "0" ] || fail "attach_to_network was called for the Singapore worker"

nodes="$(awk '/^NODES="/{f=1;next} f&&/^"$/{exit} f{print}' <<<"$out")"
[ -n "$nodes" ] || fail "no NODES block printed: $out"
grep -qE '^worker [0-9.]+ ap-southeast public$' <<<"$nodes" || fail "no public ap-southeast worker line in NODES:
$nodes"
grep -qE '^worker [0-9.]+ eu-central$' <<<"$nodes" || fail "EU worker line missing or marked public:
$nodes"
[ "$(grep -c '^worker ' <<<"$nodes")" = "3" ] || fail "want three worker lines (two zones + free):
$nodes"
ev_ip="$(awk '$1=="evaluator"{print $2}' <<<"$nodes")"
grep -qx "worker $ev_ip free" <<<"$nodes" || fail "no free-zone worker on the evaluator host (#522):
$nodes"
grep -qE '^PB_URL=http://10\.' <<<"$out" || fail "PB_URL should stay the PocketBase private address"

echo "== a re-run adopts the existing servers and keeps the marker =="
before="$(state "len(s['servers'])")"
out2="$(run)" || fail "re-run failed: $out2"
[ "$(state "len(s['servers'])")" = "$before" ] || fail "re-run created servers again"
grep -q 'nabz-worker-ap-southeast-1 already exists' <<<"$out2" || fail "re-run did not adopt the Singapore worker"
nodes2="$(awk '/^NODES="/{f=1;next} f&&/^"$/{exit} f{print}' <<<"$out2")"
grep -qE '^worker [0-9.]+ ap-southeast public$' <<<"$nodes2" || fail "re-run lost the public marker:
$nodes2"

echo "PASS: provision_test.sh"
