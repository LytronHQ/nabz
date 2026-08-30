#!/usr/bin/env bash
#
# access.sh — create (or find) the Cloudflare Access application, its Service
# Auth policy, and the service token the Worker authenticates with. Replaces the
# dashboard walkthrough; idempotent, safe to re-run.
#
#   CF_API_TOKEN=… CF_ACCOUNT_ID=… ACCESS_HOSTNAME=pb.nabz.sh \
#   ./deploy/cloudflare/access.sh
#
# Token permissions: Access: Apps and Policies Write + Access: Service Tokens
# Edit (both account-level).
#
# Prints `CF_ACCESS_CLIENT_ID=…` and, ONLY when the token was created or rotated,
# `CF_ACCESS_CLIENT_SECRET=…` as the last lines on stdout. Cloudflare returns a
# service token's secret exactly once, at creation — so a re-run against an
# existing token cannot reprint it. Pass ROTATE_TOKEN=1 to mint a new secret,
# which invalidates the old one: the Worker is down until the new value is
# deployed.
set -euo pipefail

: "${CF_API_TOKEN:?set CF_API_TOKEN (Access Apps and Policies Write + Service Tokens Edit)}"
: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
: "${ACCESS_HOSTNAME:?set ACCESS_HOSTNAME (e.g. pb.nabz.sh)}"
APP_NAME="${APP_NAME:-nabz-pocketbase}"
# Derived from APP_NAME, which is already per-environment (nabz-pocketbase vs
# nabz-staging-pocketbase), so each environment gets its OWN service token with no
# extra configuration.
#
# It used to default to a single "nabz-worker" shared by every environment, and a
# Cloudflare service-token secret is retrievable only at creation. So the SECOND
# environment provisioned found the first one's token, took the reuse branch,
# stored a client id with no secret, and could not authenticate — while rotating
# the token to fix one environment silently invalidated the other's stored copy.
TOKEN_NAME="${TOKEN_NAME:-${APP_NAME}-worker}"
POLICY_NAME="${POLICY_NAME:-worker-service-token}"

API="https://api.cloudflare.com/client/v4"
log() { echo "$*" >&2; }
die() { echo "error: $*" >&2; exit 1; }
command -v jq >/dev/null || die "missing jq"

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

# A minted secret exists exactly once, in this process. Every Cloudflare call
# after the mint can die, and several do their own validation — so a first run
# that failed later left a token whose secret was gone forever, and every re-run
# then took the reuse branch and could never recover it. One failed run
# permanently burned the token.
#
# This prints whatever was minted on ANY exit path, so a later failure costs a
# re-run rather than a credential. The caller stores what it sees and then honours
# the exit status.
emit_credentials() {
  [ -n "${CLIENT_ID:-}" ] && echo "CF_ACCESS_CLIENT_ID=${CLIENT_ID}"
  [ -n "${CLIENT_SECRET:-}" ] && echo "CF_ACCESS_CLIENT_SECRET=${CLIENT_SECRET}"
  return 0
}
EMITTED=0
on_exit() {
  local rc=$?
  if [ "$EMITTED" = "0" ] && [ -n "${CLIENT_SECRET:-}" ]; then
    log "!! exiting with status $rc AFTER minting a service-token secret."
    log "!! emitting it anyway — it cannot be retrieved again."
    emit_credentials
  fi
}
trap on_exit EXIT

# --- service token -----------------------------------------------------------
TOKENS="$(cf GET "/accounts/${CF_ACCOUNT_ID}/access/service_tokens")"
TOKEN_ID="$(jq -r --arg n "$TOKEN_NAME" '.result[] | select(.name==$n) | .id' <<<"$TOKENS" | head -1)"
CLIENT_ID=""; CLIENT_SECRET=""
if [ -z "$TOKEN_ID" ]; then
  log "==> creating service token $TOKEN_NAME"
  body="$(jq -nc --arg n "$TOKEN_NAME" '{name:$n, duration:"forever"}')"
  created="$(cf POST "/accounts/${CF_ACCOUNT_ID}/access/service_tokens" "$body")"
  TOKEN_ID="$(jq -r '.result.id' <<<"$created")"
  CLIENT_ID="$(jq -r '.result.client_id' <<<"$created")"
  CLIENT_SECRET="$(jq -r '.result.client_secret' <<<"$created")"
elif [ "${ROTATE_TOKEN:-0}" = "1" ]; then
  log "==> rotating service token $TOKEN_NAME (the old secret stops working NOW)"
  rotated="$(cf POST "/accounts/${CF_ACCOUNT_ID}/access/service_tokens/${TOKEN_ID}/rotate")"
  CLIENT_ID="$(jq -r '.result.client_id' <<<"$rotated")"
  CLIENT_SECRET="$(jq -r '.result.client_secret' <<<"$rotated")"
else
  log "· service token $TOKEN_NAME exists — secret not retrievable (ROTATE_TOKEN=1 to mint a new one)"
  CLIENT_ID="$(jq -r --arg n "$TOKEN_NAME" '.result[] | select(.name==$n) | .client_id' <<<"$TOKENS" | head -1)"
fi

# --- application --------------------------------------------------------------
APPS="$(cf GET "/accounts/${CF_ACCOUNT_ID}/access/apps")"
APP_ID="$(jq -r --arg d "$ACCESS_HOSTNAME" '.result[] | select(.domain==$d) | .id' <<<"$APPS" | head -1)"
if [ -z "$APP_ID" ]; then
  log "==> creating Access application for $ACCESS_HOSTNAME"
  body="$(jq -nc --arg n "$APP_NAME" --arg d "$ACCESS_HOSTNAME" \
    '{name:$n, domain:$d, type:"self_hosted", session_duration:"24h"}')"
  APP_ID="$(cf POST "/accounts/${CF_ACCOUNT_ID}/access/apps" "$body" | jq -r '.result.id')"
else
  log "· Access application for $ACCESS_HOSTNAME exists ($APP_ID)"
fi

# --- policy -------------------------------------------------------------------
# decision=non_identity is what makes a service-token rule actually gate: an
# "allow" policy would also admit browser identity flows, which is a second door.
POLICIES="$(cf GET "/accounts/${CF_ACCOUNT_ID}/access/apps/${APP_ID}/policies")"
POLICY_ID="$(jq -r --arg n "$POLICY_NAME" '.result[] | select(.name==$n) | .id' <<<"$POLICIES" | head -1)"
pbody="$(jq -nc --arg n "$POLICY_NAME" --arg t "$TOKEN_ID" \
  '{name:$n, decision:"non_identity", include:[{service_token:{token_id:$t}}]}')"
if [ -z "$POLICY_ID" ]; then
  log "==> creating Service Auth policy $POLICY_NAME"
  cf POST "/accounts/${CF_ACCOUNT_ID}/access/apps/${APP_ID}/policies" "$pbody" >/dev/null
else
  log "==> updating Service Auth policy $POLICY_NAME"
  cf PUT "/accounts/${CF_ACCOUNT_ID}/access/apps/${APP_ID}/policies/${POLICY_ID}" "$pbody" >/dev/null
fi

# Any other policy on this app is a way in that bypasses the token. Refuse to
# leave one in place silently.
OTHERS="$(jq -r --arg n "$POLICY_NAME" '[.result[] | select(.name != $n) | .name] | join(", ")' <<<"$POLICIES")"
[ -z "$OTHERS" ] || die "extra policies on this application: ${OTHERS}. Access ORs policies, so each one is another way past the service token. Remove them and re-run."

log "==> done."
EMITTED=1
emit_credentials
exit 0
