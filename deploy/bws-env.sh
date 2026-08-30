#!/usr/bin/env bash
#
# bws-env.sh — materialize an environment's full config from Bitwarden Secrets
# Manager plus the committed non-secret vars.
#
#   ./deploy/bws-env.sh prod                 # write deploy/.materialized/prod.env, print its path
#   ./deploy/bws-env.sh prod --stdout        # print KEY='value' lines instead (nothing on disk)
#
# BWS is the single source of truth for secret VALUES. This repo holds structure
# only: deploy/environments/<env>.vars carries the non-secret settings and the
# project id, and nothing here ever contains a plaintext secret.
#
# Values come from two projects: nabz-shared for credentials that are genuinely
# one account (MailerSend, Better Stack, the GitHub PAT), and
# nabz-<env> for everything that differs. The environment project wins on a
# clash, so anything shared can still be overridden per environment.
#
# Needs BWS_ACCESS_TOKEN — the machine account for THAT environment, granted read
# on its own project and on nabz-shared, and nothing else. The wrong token fails
# closed rather than crossing environments.
set -euo pipefail

ENV_NAME="${1:-}"
MODE="${2:-file}"
[ -n "$ENV_NAME" ] || { echo "usage: $0 <prod|staging> [--stdout]" >&2; exit 1; }

case "$ENV_NAME" in prod) ENV_NAME=production ;; esac   # BWS project is nabz-prod; the environment is `production`

HERE="$(cd "$(dirname "$0")" && pwd)"
VARS_FILE="$HERE/environments/${ENV_NAME}.vars"
OUT_DIR="$HERE/.materialized"
OUT_FILE="$OUT_DIR/${ENV_NAME}.env"

die() { echo "error: $*" >&2; exit 1; }

# shellcheck source=resolve-token.sh
. "$HERE/resolve-token.sh"

command -v bws >/dev/null 2>&1 || die "bws not installed. https://bitwarden.com/help/secrets-manager-cli/
  macOS: brew install bitwarden/tap/bws   ·   Linux: cargo install bws, or the release binary."
command -v jq >/dev/null 2>&1 || die "jq not installed (apt install jq / brew install jq)."
[ -n "${BWS_ACCESS_TOKEN:-}" ] || die "BWS_ACCESS_TOKEN is not set.
  It is the machine-account access token for the '$ENV_NAME' project, kept in your
  password manager. Export it for this shell only:
    read -rs BWS_ACCESS_TOKEN && export BWS_ACCESS_TOKEN"
[ -f "$VARS_FILE" ] || die "missing $VARS_FILE"

# Project id is not a secret, so it lives with the rest of the structure.
BWS_PROJECT_ID="$(sed -n 's/^BWS_PROJECT_ID=//p' "$VARS_FILE" | head -1)"
[ -n "$BWS_PROJECT_ID" ] || die "BWS_PROJECT_ID is not set in $VARS_FILE"
BWS_SHARED_PROJECT_ID="$(sed -n 's/^BWS_SHARED_PROJECT_ID=//p' "$VARS_FILE" | head -1)"

# Shell-quote, because values legitimately contain spaces and newlines — an SSH
# key and a cron expression both live in here.
kv() { printf "%s='%s'\n" "$1" "$(printf '%s' "${2:-}" | sed "s/'/'\\\\''/g")"; }

emit() {
  # Non-secret vars first, so a secret of the same name wins if both define it.
  while IFS='=' read -r key val; do
    case "$key" in ''|\#*|BWS_PROJECT_ID|BWS_SHARED_PROJECT_ID) continue ;; esac
    kv "$key" "$val"
  done < "$VARS_FILE"

  # Shared before environment-specific: later assignments win when sourced, so a
  # per-environment secret overrides the shared one of the same name.
  local shared=""
  if [ -n "$BWS_SHARED_PROJECT_ID" ]; then
    shared="$(bws secret list "$BWS_SHARED_PROJECT_ID" --output json 2>/dev/null)" \
      || die "bws could not read the shared project $BWS_SHARED_PROJECT_ID.
  Grant the '$ENV_NAME' machine account read access to nabz-shared, or drop
  BWS_SHARED_PROJECT_ID from $VARS_FILE."
    jq -r '.[] | .key + "=" + (.value | @sh)' <<<"$shared"
  fi

  local json
  json="$(bws secret list "$BWS_PROJECT_ID" --output json 2>/dev/null)" \
    || die "bws could not read project $BWS_PROJECT_ID. Wrong BWS_ACCESS_TOKEN for '$ENV_NAME', or no access."
  local count
  count="$(jq 'length' <<<"$json")"
  [ "$count" -gt 0 ] || die "project $BWS_PROJECT_ID returned no secrets — wrong project id?"
  # @sh on the VALUE only: yields KEY='…' with embedded quotes/newlines escaped.
  jq -r '.[] | .key + "=" + (.value | @sh)' <<<"$json"

  # The R2 endpoint is just CF_ACCOUNT_ID in a URL, and CF_ACCOUNT_ID is already
  # here. Deriving it removes the only committed value that needed hand-editing,
  # and with it the chance of backups pointing at someone else's account.
  if [ -z "${PB_BACKUP_S3_ENDPOINT_SET:-}" ]; then
    local acct
    acct="$(jq -r '.[] | select(.key == "CF_ACCOUNT_ID") | .value' <<<"${shared:-[]}" 2>/dev/null | head -1)"
    [ -n "$acct" ] || acct="$(jq -r '.[] | select(.key == "CF_ACCOUNT_ID") | .value' <<<"$json" | head -1)"
    [ -n "$acct" ] && kv PB_BACKUP_S3_ENDPOINT "https://${acct}.r2.cloudflarestorage.com"
  fi
}

if [ "$MODE" = "--stdout" ]; then
  emit
  exit 0
fi

mkdir -p "$OUT_DIR"
umask 077
emit > "$OUT_FILE"
chmod 600 "$OUT_FILE"
echo "$OUT_FILE"
