#!/usr/bin/env bash
#
# tunnel.sh — create (or find) the Cloudflare Tunnel that fronts PocketBase, wire
# its ingress and DNS, and print the connector token. Replaces the dashboard
# walkthrough: same shape as deploy/hetzner/provision.sh — plain curl + jq,
# idempotent, safe to re-run.
#
#   CF_API_TOKEN=… CF_ACCOUNT_ID=… CF_ZONE_NAME=nabz.sh \
#   TUNNEL_HOSTNAME=pb.nabz.sh PB_BIND_IP=10.0.0.2 ./deploy/cloudflare/tunnel.sh
#
# Token permissions: Cloudflare Tunnel Edit (account) + DNS Edit (zone).
#
# Prints `TUNNEL_TOKEN=<token>` on stdout as the LAST line; everything else goes
# to stderr, so a caller can capture it without parsing noise. The token is a
# credential — never echo it into a log.
set -euo pipefail

: "${CF_API_TOKEN:?set CF_API_TOKEN (Cloudflare Tunnel Edit + DNS Edit)}"
: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
: "${CF_ZONE_NAME:?set CF_ZONE_NAME (e.g. nabz.sh)}"
: "${TUNNEL_HOSTNAME:?set TUNNEL_HOSTNAME (e.g. pb.nabz.sh)}"
: "${PB_BIND_IP:?set PB_BIND_IP (the PRIVATE address of the PocketBase node)}"
TUNNEL_NAME="${TUNNEL_NAME:-nabz-pocketbase}"
PB_PORT="${PB_PORT:-8090}"

# The origin cloudflared dials. It defaults to the compose SERVICE NAME, not
# PB_BIND_IP, because cloudflared runs as a container in the same compose project
# as PocketBase (deploy/pocketbase.yml, `tunnel` profile) and Docker's DNS
# resolves it on their shared network.
#
# Sending it to the host's private address instead makes the traffic leave the
# container, hit the host, and meet ufw — which harden.sh configures to allow
# 8090 only from the private subnet (10.0.0.0/16). cloudflared dials from the
# Docker bridge (172.16.0.0/12), so the packets were dropped and every request
# failed with "dial tcp <private-ip>:8090: i/o timeout" while PocketBase was
# healthy and answering on that exact address from the host itself.
#
# Override for a cloudflared that is NOT co-located with PocketBase — then it
# genuinely has to cross the private network, and the ufw rule is what allows it.
TUNNEL_ORIGIN="${TUNNEL_ORIGIN:-http://pocketbase:${PB_PORT}}"

API="https://api.cloudflare.com/client/v4"
log() { echo "$*" >&2; }
die() { echo "error: $*" >&2; exit 1; }
command -v jq >/dev/null || die "missing jq"

# cf METHOD PATH [json] — fail loudly on API-level errors, which come back inside
# a 200 body as {"success": false, "errors": [...]}.
cf() {
  local method="$1" path="$2" body="${3:-}" out
  if [ -n "$body" ]; then
    out="$(curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $CF_API_TOKEN" \
      -H 'Content-Type: application/json' -d "$body")"
  else
    out="$(curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $CF_API_TOKEN")"
  fi
  jq -e '.success == true' >/dev/null <<<"$out" \
    || die "Cloudflare API $method $path: $(jq -c '.errors // .' <<<"$out")"
  echo "$out"
}

ZONE_ID="$(cf GET "/zones?name=${CF_ZONE_NAME}" | jq -r '.result[0].id // empty')"
[ -n "$ZONE_ID" ] || die "zone '$CF_ZONE_NAME' not found (is the DNS Edit permission scoped to it?)"

# --- tunnel: find by name, else create ---------------------------------------
# is_deleted=false — deleted tunnels keep their name and would shadow a lookup.
TUNNEL_ID="$(cf GET "/accounts/${CF_ACCOUNT_ID}/cfd_tunnel?name=${TUNNEL_NAME}&is_deleted=false" \
  | jq -r '.result[0].id // empty')"
if [ -n "$TUNNEL_ID" ]; then
  log "· tunnel $TUNNEL_NAME exists ($TUNNEL_ID)"
else
  log "==> creating tunnel $TUNNEL_NAME"
  # config_src=cloudflare — remotely managed, so ingress lives in the API below
  # rather than in a config file on the host. The container only needs the token.
  body="$(jq -nc --arg n "$TUNNEL_NAME" '{name:$n, config_src:"cloudflare"}')"
  TUNNEL_ID="$(cf POST "/accounts/${CF_ACCOUNT_ID}/cfd_tunnel" "$body" | jq -r '.result.id')"
  log "   created ($TUNNEL_ID)"
fi

# --- ingress -----------------------------------------------------------------
# HTTP, not HTTPS: the hop from cloudflared to PocketBase is inside the private
# network and PocketBase serves plain HTTP. The catch-all 404 is required — a
# config without it is rejected.
log "==> ingress: ${TUNNEL_HOSTNAME} -> ${TUNNEL_ORIGIN}"
ingress="$(jq -nc --arg h "$TUNNEL_HOSTNAME" --arg svc "$TUNNEL_ORIGIN" \
  '{config:{ingress:[{hostname:$h, service:$svc}, {service:"http_status:404"}]}}')"
cf PUT "/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations" "$ingress" >/dev/null

# --- DNS ---------------------------------------------------------------------
# Proxied CNAME to the tunnel. Must be proxied: an unproxied record would expose
# the tunnel address directly and skip Access entirely.
TARGET="${TUNNEL_ID}.cfargotunnel.com"
REC_ID="$(cf GET "/zones/${ZONE_ID}/dns_records?name=${TUNNEL_HOSTNAME}" | jq -r '.result[0].id // empty')"
BODY="$(jq -nc --arg n "$TUNNEL_HOSTNAME" --arg c "$TARGET" \
  '{type:"CNAME", name:$n, content:$c, proxied:true, comment:"nabz PocketBase tunnel (#343)"}')"
if [ -n "$REC_ID" ]; then
  log "==> updating DNS $TUNNEL_HOSTNAME -> $TARGET"
  cf PUT "/zones/${ZONE_ID}/dns_records/${REC_ID}" "$BODY" >/dev/null
else
  log "==> creating DNS $TUNNEL_HOSTNAME -> $TARGET"
  cf POST "/zones/${ZONE_ID}/dns_records" "$BODY" >/dev/null
fi

TOKEN="$(cf GET "/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/token" | jq -r '.result')"
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || die "tunnel created but no connector token returned"
log "==> done. The tunnel stays DOWN until a connector runs (deploy-nodes starts two)."
echo "TUNNEL_TOKEN=${TOKEN}"
