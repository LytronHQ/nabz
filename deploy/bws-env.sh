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
# The reading, merging and shell-quoting are done by `deploy/.ops/secrets.sh env`, the
# vendored ops `secrets` module. This script is the nabz policy around it: which
# projects an environment reads, where the result lands, the `prod` alias, and
# the one derived value. deploy/bws_env_test.sh pins all of that.
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

# emit() writes a filtered copy of the vars file for secrets.sh --vars.
FILTERED=""
trap '[ -z "$FILTERED" ] || rm -f "$FILTERED"' EXIT

# shellcheck source=resolve-token.sh
. "$HERE/resolve-token.sh"

# Neither is called from here any more — secrets.sh is what runs them. Checked
# here anyway, because these two messages name the install command and the
# module's cannot, and a missing dependency should be the first thing a person
# sees rather than something reported from one layer down.
command -v bws >/dev/null 2>&1 || die "bws not installed. https://bitwarden.com/help/secrets-manager-cli/
  macOS: brew install bitwarden/tap/bws   ·   Linux: cargo install bws, or the release binary."
command -v jq >/dev/null 2>&1 || die "jq not installed (apt install jq / brew install jq)."

# The module is fetched, not committed. Cheap when the cache is warm.
"$HERE/ops-fetch.sh" --check >/dev/null 2>&1 || "$HERE/ops-fetch.sh" >/dev/null
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

# The merging, quoting and project ordering are done by the vendored ops
# `secrets` module (deploy/secrets.sh). What stays here is this repo's policy:
# which projects an environment reads, where the output lands, the `prod` alias,
# and the one derived value.
emit() {
  # The module passes every KEY=value in --vars straight through, and these two
  # are structure rather than configuration — a node has no business knowing
  # which Bitwarden project it was built from.
  FILTERED="$(mktemp)"
  grep -vE '^[[:space:]]*(BWS_PROJECT_ID|BWS_SHARED_PROJECT_ID)=' "$VARS_FILE" > "$FILTERED"

  # Shared first, so an environment's own secret overrides the shared one of the
  # same name. --vars is read before either, which makes a committed non-secret
  # the lowest precedence of the three.
  local projects=()
  [ -z "$BWS_SHARED_PROJECT_ID" ] || projects+=(--project "$BWS_SHARED_PROJECT_ID")
  projects+=(--project "$BWS_PROJECT_ID")

  # The token goes in on stdin, never in argv: argv is readable by every user
  # on the machine through ps.
  local merged
  merged="$(printf '%s' "$BWS_ACCESS_TOKEN" | "$HERE/.ops/secrets.sh" env \
    --access-token-file - --vars "$FILTERED" "${projects[@]}")" \
    || die "could not materialize '$ENV_NAME' from Bitwarden — see the error above.
  The usual causes are the wrong BWS_ACCESS_TOKEN for '$ENV_NAME', or a machine
  account without read access to $BWS_SHARED_PROJECT_ID as well as its own project."

  printf '%s\n' "$merged"

  # The R2 endpoint is just CF_ACCOUNT_ID in a URL, and CF_ACCOUNT_ID is already
  # here. Deriving it removes the only committed value that needed hand-editing,
  # and with it the chance of backups pointing at someone else's account.
  #
  # Appended last, so it wins over a stored copy — the same order as before.
  if [ -z "${PB_BACKUP_S3_ENDPOINT_SET:-}" ]; then
    local acct
    # eval of the one matching line, rather than a regex: the value is already
    # shell-quoted by secrets.sh, so the shell is the thing that unquotes it
    # correctly. A sed would have to re-implement @sh's escaping to stay right.
    acct="$(eval "$(printf '%s\n' "$merged" | grep '^CF_ACCOUNT_ID=' | head -1)" 2>/dev/null
            printf '%s' "${CF_ACCOUNT_ID:-}")"
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
