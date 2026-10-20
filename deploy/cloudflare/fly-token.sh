#!/usr/bin/env bash
#
# fly-token.sh — mint (or reuse) the Fly worker's Cloudflare Access service token
# and store it in the environment's Bitwarden project.
#
#   ./deploy/cloudflare/fly-token.sh production
#   ROTATE_FLY_TOKEN=1 ./deploy/cloudflare/fly-token.sh production
#
# Run from the machine that deploys Fly. That is the whole point of it existing:
# the token has to end up in Bitwarden, where remote-deploy.sh materializes the
# env file from, and the CI machine account is READ-ONLY on that project — on
# purpose, because write access there would let a compromised workflow rewrite
# PocketBase's credentials and everything else in the environment. A credential
# minted roughly once a year does not justify that.
#
# So CI keeps managing the web token (infra-access), and this manages the Fly
# one. They are separate tokens on the SAME Access policy, so revoking or
# rotating either leaves the other working.
#
# Needs: bws + jq + curl, BWS_ACCESS_TOKEN with WRITE on nabz-<env> (yours, not
# CI's — deploy/.env's BWS_ACCESS_TOKEN_<ENV> is picked up automatically).
set -euo pipefail

ENV_NAME="${1:-}"
[ -n "$ENV_NAME" ] || { echo "usage: $0 <production|staging>" >&2; exit 1; }
case "$ENV_NAME" in prod) ENV_NAME=production ;; esac

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
VARS_FILE="$DEPLOY/environments/${ENV_NAME}.vars"

die() { echo "error: $*" >&2; exit 1; }
log() { echo "$*" >&2; }

command -v bws >/dev/null 2>&1 || die "bws not installed. https://bitwarden.com/help/secrets-manager-cli/"
command -v jq  >/dev/null 2>&1 || die "jq not installed."
[ -f "$VARS_FILE" ] || die "missing $VARS_FILE"

# shellcheck source=../resolve-token.sh
. "$DEPLOY/resolve-token.sh"
[ -n "${BWS_ACCESS_TOKEN:-}" ] || die "BWS_ACCESS_TOKEN is not set for '$ENV_NAME'.
  This needs YOUR machine account with WRITE on the project, not CI's read-only one."

BWS_PROJECT_ID="$(sed -n 's/^BWS_PROJECT_ID=//p' "$VARS_FILE" | head -1)"
[ -n "$BWS_PROJECT_ID" ] || die "BWS_PROJECT_ID is not set in $VARS_FILE"

# Only the four values access.sh needs, rather than sourcing the whole
# environment: this script has no business holding PocketBase's password.
log "==> reading Cloudflare settings for $ENV_NAME"
env_out="$("$DEPLOY/bws-env.sh" "$ENV_NAME" --stdout)" || die "could not materialize $ENV_NAME from Bitwarden"
eval "$(printf '%s\n' "$env_out" | grep -E '^(CF_API_TOKEN|CF_ACCOUNT_ID|PB_HOSTNAME|ACCESS_APP_NAME)=' || true)"
unset env_out
[ -n "${CF_API_TOKEN:-}" ]   || die "CF_API_TOKEN is not in the $ENV_NAME project"
[ -n "${CF_ACCOUNT_ID:-}" ]  || die "CF_ACCOUNT_ID is not in the $ENV_NAME project"
[ -n "${PB_HOSTNAME:-}" ]    || die "PB_HOSTNAME is not set in $VARS_FILE"

# --- mint ---------------------------------------------------------------------
# Naming this token and no other is what keeps the web's credential safe:
# access.sh only touches the --token names it is given, and KEEPS every other
# token already in the policy. So a fly rotation cannot invalidate the web's,
# and this run cannot drop it either.
#
# The names are not free choices. A different token name mints a NEW token
# rather than reusing the live one, and Cloudflare returns a secret only at
# creation — so the live credential would become unrecoverable. Same for the
# policy: the module defaults to "service-tokens", this application's is
# "worker-service-token", and a second policy is a second door.
APP_NAME="${ACCESS_APP_NAME:-nabz-pocketbase}"
FLY_TOKEN_NAME="${FLY_TOKEN_NAME:-${APP_NAME}-fly-worker}"
FLY_VAR="$("$HERE/token-var.sh" "$FLY_TOKEN_NAME")"

# An if, not `[ … ] && rotate=(…)`: under set -e that one-liner returns 1 on the
# common path and kills the script before it ever mints anything.
rotate=()
if [ "${ROTATE_FLY_TOKEN:-0}" = "1" ]; then
  rotate=(--rotate "$FLY_TOKEN_NAME")
fi

# The module is fetched, not committed.
"$DEPLOY/ops-fetch.sh" --check >/dev/null 2>&1 || "$DEPLOY/ops-fetch.sh" >/dev/null

log "==> ensuring the fly service token on $PB_HOSTNAME"
rc=0
# The API token goes in on stdin, never in argv: every user on the machine can
# read another's argv through ps.
out="$(printf '%s' "$CF_API_TOKEN" | "$DEPLOY/.ops/edge.sh" access \
       --hostname "$PB_HOSTNAME" --account-id "$CF_ACCOUNT_ID" \
       --api-token-file - --app-name "$APP_NAME" \
       --policy-name "${POLICY_NAME:-worker-service-token}" \
       --token "$FLY_TOKEN_NAME" "${rotate[@]}")" || rc=$?

FLY_ID="$(printf '%s\n' "$out" | sed -n "s/^CF_ACCESS_CLIENT_ID_${FLY_VAR}=//p")"
FLY_SECRET="$(printf '%s\n' "$out" | sed -n "s/^CF_ACCESS_CLIENT_SECRET_${FLY_VAR}=//p")"

# Print whatever was minted on ANY failure path from here on. Cloudflare returns a
# service-token secret exactly once, so an error after the mint must not swallow
# the only copy — the operator can still paste it into Bitwarden by hand.
emitted=0
emit() {
  [ "$emitted" = "1" ] && return 0
  emitted=1
  [ -n "$FLY_SECRET" ] || return 0
  echo "!! store these by hand — Cloudflare will not show the secret again:" >&2
  echo "FLY_CF_ACCESS_CLIENT_ID=${FLY_ID}"
  echo "FLY_CF_ACCESS_CLIENT_SECRET=${FLY_SECRET}"
}
trap emit EXIT

if [ -z "$FLY_ID" ]; then
  [ "$rc" = "0" ] || die "access.sh failed (exit $rc) — see the log above"
  die "access.sh returned no fly client id"
fi

# --- store --------------------------------------------------------------------
upsert() { # key value
  local key="$1" val="$2" id
  id="$(bws secret list "$BWS_PROJECT_ID" --output json 2>/dev/null \
        | jq -r --arg k "$key" '.[] | select(.key==$k) | .id' | head -1)" \
    || die "could not list secrets in $BWS_PROJECT_ID (wrong BWS_ACCESS_TOKEN for '$ENV_NAME'?)"
  if [ -n "$id" ]; then
    bws secret edit --value "$val" "$id" >/dev/null \
      || die "could not update $key in Bitwarden — the token is printed above"
    log "   updated $key"
  else
    bws secret create "$key" "$val" "$BWS_PROJECT_ID" >/dev/null \
      || die "could not create $key in Bitwarden — the token is printed above.
  A read-only machine account cannot write: use YOUR credentials, not CI's."
    log "   created $key"
  fi
}

log "==> storing in Bitwarden project $BWS_PROJECT_ID"
upsert FLY_CF_ACCESS_CLIENT_ID "$FLY_ID"

if [ -n "$FLY_SECRET" ]; then
  upsert FLY_CF_ACCESS_CLIENT_SECRET "$FLY_SECRET"
else
  # Reused an existing token. Its secret is not retrievable, so the stored one is
  # the only copy — and "unchanged" is only reassuring when there IS one.
  have="$(bws secret list "$BWS_PROJECT_ID" --output json 2>/dev/null \
          | jq -r '.[] | select(.key=="FLY_CF_ACCESS_CLIENT_SECRET") | .id' | head -1)"
  [ -n "$have" ] \
    || die "the fly service token already exists in Cloudflare, but no
  FLY_CF_ACCESS_CLIENT_SECRET is stored in Bitwarden. Cloudflare returns that
  secret only at creation, so the missing half cannot be recovered — re-run with
  ROTATE_FLY_TOKEN=1 to mint a fresh pair. It affects the fly worker only."
  log "   existing token reused; the stored secret is unchanged"
fi

# The credential is safe now; surface any earlier failure.
[ "$rc" = "0" ] || die "access.sh exited $rc after the token was stored — re-run to finish the remaining steps"

emitted=1   # stored successfully; nothing to print
log "==> done. remote-deploy.sh will pick it up from Bitwarden on the next run."
