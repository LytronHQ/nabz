#!/usr/bin/env bash
#
# setup-env.sh — inspect and fill a GitHub Environment.
#
#   ./deploy/github/setup-env.sh production            # report, then push
#   ./deploy/github/setup-env.sh production --status    # report only
#   ./deploy/github/setup-env.sh production --sync      # push BWS values to GitHub
#   ./deploy/github/setup-env.sh production --sources   # every secret and where it is issued
#   ./deploy/github/setup-env.sh --audit                # audit every environment
#   ./deploy/github/setup-env.sh production --audit     # just this one
#
# THIS SCRIPT IS THE SOURCE OF TRUTH for what an environment needs. The manifest
# below is the only list; the status report, the generated .env template and the
# failure messages all derive from it, so they cannot drift apart the way a
# README section does.
#
# Secret VALUES come from Bitwarden Secrets Manager, via deploy/bws-env.sh — one
# direction, BWS -> GitHub, so BWS stays the single source of truth. Nothing is
# read from a plaintext file on disk. Non-secret variables come from
# deploy/environments/<env>.vars, which is committed.
#
# Needs BWS_ACCESS_TOKEN for that environment's machine account.
#
# GitHub never returns a secret's value, only its name. So a secret already
# stored is reported as set and left alone; blank in the file never means erase.
set -euo pipefail

# name | required | where the value comes from
MANIFEST=(
  "BWS_ACCESS_TOKEN|yes|Bitwarden Secrets Manager > Machine accounts > this environment's account > Access tokens. The workflows read every other value through it, so it is the one secret GitHub genuinely needs."
  "CF_API_TOKEN|yes|Cloudflare > My Profile > API Tokens > Create Custom Token. Steps + the five permission rows: README, Creating the API credentials. One Cloudflare account and one zone serve both environments, so this lives in nabz-shared."
  "CF_ACCOUNT_ID|yes|Cloudflare > any zone > Overview, right sidebar, Account ID. nabz-shared."
  "HCLOUD_TOKEN_RW|yes|Hetzner console > this fleet's project > Security > API tokens, Read & Write."
  "GH_SECRETS_PAT|yes|GitHub > Developer settings > Fine-grained tokens. Owner LytronHQ, this repo. Needs BOTH 'Secrets: Read and write' AND 'Environments: Read and write' — every workflow write is an ENVIRONMENT secret (gh secret set --env), and those are gated by Environments, not Secrets. A token with only Secrets passes every repo-level check and then 403s on the first provisioning step. nabz-shared."
  "SSH_PRIVATE_KEY|yes|NOT stored in Bitwarden. Read from the ~/.ssh file named by SSH_KEY_FILE (set per environment in deploy/environments/<env>.vars) and pushed straight to GitHub. A private key already has a home; copying it into a second one only widens the blast radius."
  "SMTP_USERNAME|no|MailerSend > Domains > your domain > SMTP (generated credentials, not your login). nabz-shared."
  "SMTP_PASSWORD|no|MailerSend > Domains > your domain > SMTP. nabz-shared."
  "PB_BACKUP_S3_ACCESS_KEY|no|Cloudflare > R2 > Manage account > Account API tokens (an ACCOUNT token, not the user token under My Profile): Access Key ID."
  "PB_BACKUP_S3_SECRET|no|Cloudflare > R2 > Manage account > Account API tokens: Secret Access Key. Shown once."
  "BETTERSTACK_API_TOKEN|no|Better Stack > Settings > API tokens. Used by infra-watch (monitors, the evaluator heartbeat, the Telegram webhooks) and by remote-deploy.sh to look the heartbeat ping URL back up. nabz-shared; the script namespaces per environment."
)

ENV_NAME="${1:-}"
MODE="${2:-apply}"
case "${ENV_NAME:-}" in
  --audit)
    # No environment named: do them all, so verifying is one command and cannot
    # silently skip the one you forgot.
    shift || true
    rc=0
    for e in "$(cd "$(dirname "$0")/../environments" && ls *.vars 2>/dev/null | sed 's/\.vars$//')"; do
      for env_one in $e; do
        "$0" "$env_one" --audit || rc=1
        echo
      done
    done
    exit "$rc" ;;
esac
[ -n "$ENV_NAME" ] || { echo "usage: $0 [<environment>] [--status|--sources|--audit]"; exit 1; }
case "$ENV_NAME" in prod) ENV_NAME=production ;; esac

HERE="$(cd "$(dirname "$0")" && pwd)"
VARS_FILE="$HERE/../environments/${ENV_NAME}.vars"

# shellcheck source=../resolve-token.sh
. "$HERE/../resolve-token.sh"

# The deploy key stays a file in ~/.ssh; only its NAME is configuration.
SSH_KEY_FILE="$(sed -n 's/^SSH_KEY_FILE=//p' "$VARS_FILE" 2>/dev/null | head -1)"
SSH_KEY_PATH="$HOME/.ssh/${SSH_KEY_FILE:-}"


field() { printf '%s' "$1" | cut -d'|' -f"$2"; }

# --- --sources: the whole manifest, whatever is already set -------------------
# Needed for rotation and for standing an environment up from another machine:
# the status report only explains what is MISSING, which is no help when the
# thing you want to replace is present.
if [ "$MODE" = "--sources" ] || [ "$MODE" = "--markdown" ]; then
  if [ "$MODE" = "--markdown" ]; then
    # Rendered into the README by render-docs.sh and checked by CI, so the table
    # there and this manifest cannot disagree.
    echo "| Secret | Required | Where it is issued |"
    echo "|---|---|---|"
    for row in "${MANIFEST[@]}"; do
      req=yes; [ "$(field "$row" 2)" = no ] && req="optional"
      printf '| `%s` | %s | %s |\n' "$(field "$row" 1)" "$req" "$(field "$row" 3)"
    done
  else
    echo "Every secret '$ENV_NAME' needs, and where each is issued:"
    for row in "${MANIFEST[@]}"; do
      req=""; [ "$(field "$row" 2)" = no ] && req="  (optional)"
      echo
      echo "  $(field "$row" 1)$req"
      echo "    $(field "$row" 3)"
    done
  fi
  exit 0
fi

[ -f "$VARS_FILE" ] || { echo "missing $VARS_FILE"; exit 1; }

# --- --audit: check Bitwarden itself, before anything is pushed anywhere -------
# --status answers "does GitHub have it". This answers "does Bitwarden have it,
# in the right project, with a real value" — which is where a from-scratch setup
# actually goes wrong, and it says which project each value resolved from.
if [ "$MODE" = "--audit" ]; then
  [ -n "${BWS_ACCESS_TOKEN:-}" ] || {
    echo "BWS_ACCESS_TOKEN is not set — this reads Bitwarden directly."
    echo "  read -rs BWS_ACCESS_TOKEN && export BWS_ACCESS_TOKEN"; exit 1; }
  command -v bws >/dev/null || { echo "bws not installed"; exit 1; }

  env_id="$(sed -n 's/^BWS_PROJECT_ID=//p' "$VARS_FILE" | head -1)"
  shared_id="$(sed -n 's/^BWS_SHARED_PROJECT_ID=//p' "$VARS_FILE" | head -1)"

  # An unreadable project is the interesting failure here, so say which one.
  fetch() { # project-id label
    [ -n "$1" ] || return 0
    bws secret list "$1" --output json 2>/dev/null \
      || { echo "  cannot read the $2 project ($1)."
           echo "  Either this token belongs to a different environment, or its machine"
           echo "  account lacks access. Put both in .env as BWS_ACCESS_TOKEN_PRODUCTION"
           echo "  and BWS_ACCESS_TOKEN_STAGING to audit everything in one run."; exit 1; }
  }
  env_json="$(fetch "$env_id" environment)"
  # bws returns an empty list, not an error, for a project this token cannot see.
  # Reporting that as "every secret is missing" would be a confident lie, and the
  # obvious next move — go add them all — creates duplicates in the wrong project.
  [ "$(jq 'length' <<<"$env_json")" -gt 0 ] || {
    echo "  the environment project ($env_id) came back empty."
    echo "  A token that cannot see a project gets an empty list, not an error, so"
    echo "  this is almost certainly the wrong environment's token. Put both in .env"
    echo "  as BWS_ACCESS_TOKEN_PRODUCTION and BWS_ACCESS_TOKEN_STAGING."; exit 1; }
  shared_json="$(fetch "$shared_id" shared)"
  [ -n "$shared_json" ] || shared_json='[]'

  # A key present with an empty value is worse than absent: it reads as "done"
  # everywhere else and fails at deploy time.
  keys_of() { jq -r '.[] | select((.value // "") != "") | .key' <<<"$1" | sort; }
  empty_of() { jq -r '.[] | select((.value // "") == "") | .key' <<<"$1" | sort; }
  ENV_KEYS="$(keys_of "$env_json")"; SHARED_KEYS="$(keys_of "$shared_json")"

  echo "'$ENV_NAME' — Bitwarden"
  echo "  environment project $env_id  ($(grep -c . <<<"$ENV_KEYS") secrets)"
  if [ -n "$shared_id" ]; then
    echo "  shared project      $shared_id  ($(grep -c . <<<"$SHARED_KEYS") secrets)"
  else
    echo "  shared project      not configured (BWS_SHARED_PROJECT_ID is blank)"
  fi
  echo

  missing=0
  for row in "${MANIFEST[@]}"; do
    name="$(field "$row" 1)"; req="$(field "$row" 2)"
    # The token that opens Bitwarden cannot live inside it. It is set by hand as a
    # GitHub environment secret; --status is what checks it.
    if [ "$name" = SSH_PRIVATE_KEY ]; then
      if [ -z "$SSH_KEY_FILE" ]; then
        printf '  %-26s %s\n' "$name" "MISSING  (SSH_KEY_FILE not set in $(basename "$VARS_FILE"))"
        missing=$((missing+1))
      elif [ -r "$SSH_KEY_PATH" ]; then
        printf '  %-26s %s\n' "$name" "~/.ssh/$SSH_KEY_FILE"
      else
        printf '  %-26s %s\n' "$name" "MISSING  (no readable ~/.ssh/$SSH_KEY_FILE)"
        missing=$((missing+1))
      fi
      continue
    fi
    if [ "$name" = BWS_ACCESS_TOKEN ]; then
      printf '  %-26s %s\n' "$name" "n/a  (GitHub only — it is what reads Bitwarden)"
      continue
    fi
    in_env=no; in_shared=no
    grep -qx "$name" <<<"$ENV_KEYS" && in_env=yes
    grep -qx "$name" <<<"$SHARED_KEYS" && in_shared=yes
    case "$in_env$in_shared" in
      yesyes) state="environment (also in shared — environment wins)" ;;
      yesno)  state="environment" ;;
      noyes)  state="shared" ;;
      *)      if [ "$req" = yes ]; then state="MISSING"; missing=$((missing+1));
              else state="-  (optional)"; fi ;;
    esac
    printf '  %-26s %s\n' "$name" "$state"
  done

  for lbl in environment shared; do
    [ "$lbl" = shared ] && j="$shared_json" || j="$env_json"
    e="$(empty_of "$j")"
    [ -n "$e" ] && { echo; echo "  Empty values in the $lbl project (present but blank):"; sed 's/^/    /' <<<"$e"; }
  done

  # Which keys are "known" was itself a hardcoded list, which drifted the moment
  # a new secret was wired up. Ask the repo instead: if nothing mentions the name,
  # nothing reads it, and it is a typo or a leftover.
  REPO_ROOT="$(cd "$HERE/../.." && pwd)"
  unref=""
  while read -r k; do
    [ -n "$k" ] || continue
    grep -rqlF --exclude-dir=.git --exclude-dir=node_modules "$k" "$REPO_ROOT" 2>/dev/null \
      || unref="$unref$k\n"
  done <<<"$(printf '%s\n' "$ENV_KEYS" "$SHARED_KEYS" | grep . | sort -u)"
  [ -n "$unref" ] && { echo; echo "  Not mentioned anywhere in this repo (typo, or left over?):";
                       printf "$unref" | sed 's/^/    /'; }

  ph="$(grep -nE '<[A-Z_]+>' "$VARS_FILE" || true)"
  [ -n "$ph" ] && { echo; echo "  Unfilled placeholders in $(basename "$VARS_FILE"):"; sed 's/^/    /' <<<"$ph"; }

  echo
  [ "$missing" = 0 ] && echo "  All required secrets present." \
    || { echo "  $missing required secret(s) missing."; exit 1; }
  exit 0
fi
# Pull the values from BWS. Only when we are about to push them — a plain status
# report should not need the access token.
# Read the values from Bitwarden. --status used to skip this and then report
# every unpushed secret as MISSING — a confident lie, since "not in GitHub yet"
# and "does not exist" need completely different actions, and the advice it
# printed sent you off to re-issue credentials that were already in the vault.
#
# It stays non-fatal in status mode: a read-only check must still work without a
# vault token or the bws binary. When the read does not happen, the report says
# so rather than guessing.
BWS_CHECKED=yes
if [ "$MODE" = "--status" ]; then
  if bws_out="$("$HERE/../bws-env.sh" "$ENV_NAME" --stdout 2>/dev/null)"; then
    eval "$bws_out"
  else
    BWS_CHECKED=no
  fi
else
  eval "$("$HERE/../bws-env.sh" "$ENV_NAME" --stdout)"
fi

REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
# per_page: these endpoints default to 10 per page, so an environment with more
# than ten variables read back as partly unset — which looks exactly like a
# half-finished push.
EXISTING="$(gh api "repos/${REPO}/environments/${ENV_NAME}/secrets?per_page=100" --jq '.secrets[].name' 2>/dev/null || true)"
EXISTING_VARS="$(gh api "repos/${REPO}/environments/${ENV_NAME}/variables?per_page=100" --jq '.variables[].name' 2>/dev/null || true)"

echo "$REPO — environment '$ENV_NAME'"
echo

blockers=()
for row in "${MANIFEST[@]}"; do
  name="$(field "$row" 1)"; req="$(field "$row" 2)"; src="$(field "$row" 3)"
  if [ "$name" = SSH_PRIVATE_KEY ]; then
    if [ -n "$SSH_KEY_FILE" ] && [ -r "$SSH_KEY_PATH" ]; then
      state="~/.ssh/$SSH_KEY_FILE"
    elif grep -qx "$name" <<<"$EXISTING"; then
      state="in GitHub"
    else
      state="MISSING"; blockers+=("$name|$src")
    fi
    printf '  %-26s %s\n' "$name" "$state"
    continue
  fi
  if [ -n "${!name:-}" ]; then
    state="from BWS"
  elif grep -qx "$name" <<<"$EXISTING"; then
    state="in GitHub"
  elif [ "$BWS_CHECKED" = no ]; then
    # Bitwarden was not readable, so absence here proves nothing about the vault.
    state="not in GitHub  (Bitwarden not checked)"
  elif [ "$req" = yes ]; then
    state="MISSING"; blockers+=("$name|$src")
  else
    state="not set (optional)"
  fi
  printf '  %-26s %s\n' "$name" "$state"
done

nvars=$(grep -cvE '^\s*(#|$)' "$VARS_FILE" || true)
ngh=$(grep -c . <<<"$EXISTING_VARS" || true)
echo
printf '  %-26s %s in %s, %s in GitHub\n' "variables" "$nvars" "$(basename "$VARS_FILE")" "$ngh"

# Name the gap rather than leaving two counts to be compared by eye. A partial
# push is the failure this script is most likely to produce and the least likely
# to be noticed: the deploy still runs, just with blanks.
missing_vars=""
while IFS= read -r line; do
  case "$line" in ''|\#*) continue ;; esac
  k="${line%%=*}"; v="${line#*=}"
  [ "$k" = "$line" ] && continue
  # An empty value is intentionally never pushed — see the apply loop.
  [ -n "$v" ] || continue
  grep -qx "$k" <<<"$EXISTING_VARS" || missing_vars="$missing_vars    $k"$'\n'
done < "$VARS_FILE"
if [ -n "$missing_vars" ]; then
  echo
  echo "  In $(basename "$VARS_FILE") but NOT in GitHub — the workflows read these as empty:"
  printf '%s' "$missing_vars"
  echo "  Re-run without --status to push them."
fi

if [ "$BWS_CHECKED" = no ]; then
  echo
  echo "  Bitwarden was not read (no token, or bws not installed), so the lines above"
  echo "  report GitHub only. Run with a vault token to see what is actually issued."
fi

if [ "${#blockers[@]}" -gt 0 ]; then
  echo
  echo "Get these before deploying:"
  for b in "${blockers[@]}"; do
    echo
    echo "  ${b%%|*}"
    echo "    ${b#*|}"
  done
  echo
  echo "  Add them to the '$ENV_NAME' project in Bitwarden Secrets Manager, keyed by"
  echo "  the exact names above, then re-run. SSH_PRIVATE_KEY is the exception:"
  echo "  it comes from ~/.ssh/\$SSH_KEY_FILE, never from Bitwarden."
fi

echo
echo "  --sources  where every secret is issued, including the ones already set"

[ "$MODE" != "--status" ] || { echo; echo "(status only)"; exit 0; }
[ "${#blockers[@]}" -eq 0 ] || { echo; echo "Refusing to apply while required secrets are missing."; exit 1; }

# The PAT is used by the WORKFLOWS, not by this script, so a token missing a
# permission is invisible here and surfaces ~40 seconds into provision-all when
# bootstrap-credentials tries to write its first environment secret. Probe it
# while we still have it in hand.
#
# Probe the SECRETS PUBLIC-KEY endpoint, which is the first call `gh secret set
# --env` makes and is gated by the Environments permission (GitHub reports
# `x-accepted-github-permissions: environments=read` for it).
#
# It used to probe GET /environments/{name}, which looks equivalent and is not:
# that endpoint is gated by `actions=read`. A token with exactly the permissions
# this repo documents 403s there while being perfectly able to write environment
# secrets — so the check refused correct tokens and sent the operator off to
# regenerate credentials that already worked.
if [ -n "${GH_SECRETS_PAT:-}" ]; then
  echo
  echo "==> checking GH_SECRETS_PAT can reach environments"
  pat_code="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $GH_SECRETS_PAT" -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/${REPO}/environments/${ENV_NAME}/secrets/public-key" 2>/dev/null || echo 000)"
  case "$pat_code" in
    200) echo "   ok — the token can reach this environment's secrets" ;;
    403) echo "   FAIL: the token cannot access environments (HTTP 403)." >&2
         echo "   Every provisioning workflow writes ENVIRONMENT secrets" >&2
         echo "   (gh secret set --env), which needs 'Environments: Read and write'." >&2
         echo "   'Secrets: Read and write' alone is not enough — it covers only" >&2
         echo "   repository secrets, so the token looks fine until provisioning runs." >&2
         echo "   Add it: GitHub > Settings > Developer settings > Fine-grained tokens" >&2
         echo "   > this token > Repository permissions > Environments: Read and write." >&2
         echo "   Editing permissions does not change the token value, so nothing" >&2
         echo "   needs re-pushing here afterwards." >&2
         exit 1 ;;
    404) echo "   WARN: environment '$ENV_NAME' not visible to the token (HTTP 404)." >&2
         echo "   Either it does not exist yet, or the token lacks Environments access." >&2 ;;
    *)   echo "   WARN: could not check the token (HTTP $pat_code); continuing." >&2 ;;
  esac
fi

echo
echo "==> applying"
# `gh variable set` falls back to reading the VALUE from stdin when --body is
# empty. Piping the vars file into the loop therefore let a single empty value
# swallow every remaining line: a vars file may hold `WRANGLER_ENV=` (correct —
# the default Workers environment has no name), so a real run pushed 13 of 22
# variables, stopped, and said nothing. The fleet then provisions with PB_VERSION,
# SMTP_* and ADMIN_EMAILS silently blank.
#
# Read the file into an array first, so the loop owns no stdin for gh to eat, and
# give each call </dev/null so it can never consume the terminal either.
pushed=()
vars_lines=()
while IFS= read -r line || [ -n "$line" ]; do vars_lines+=("$line"); done < "$VARS_FILE"
for line in "${vars_lines[@]}"; do
  key="${line%%=*}"; val="${line#*=}"
  case "$key" in ''|\#*|*[!A-Za-z0-9_]*) continue ;; esac
  [ "$key" = "$line" ] && continue          # no '=' on the line at all
  # GitHub rejects an empty variable value (HTTP 422), and an unset variable
  # already resolves to "" in a workflow expression — `vars.WRANGLER_ENV` reaches
  # deploy-web.yml's `[ -n "$WRANGLER_ENV" ]` test the same either way. So an
  # empty line here is deliberately a no-op, not a failure.
  if [ -z "$val" ]; then
    echo "   var  $key  (empty — left unset; that is the same value to a workflow)"
    continue
  fi
  if gh variable set "$key" --env "$ENV_NAME" --repo "$REPO" --body "$val" </dev/null; then
    echo "   var  $key"
    pushed+=("$key")
  else
    echo "   var  $key  FAILED" >&2
  fi
done
if [ -n "$SSH_KEY_FILE" ] && [ -r "$SSH_KEY_PATH" ]; then
  gh secret set SSH_PRIVATE_KEY --env "$ENV_NAME" --repo "$REPO" < "$SSH_KEY_PATH"
  echo "   sec  SSH_PRIVATE_KEY  (from ~/.ssh/$SSH_KEY_FILE)"
fi
for row in "${MANIFEST[@]}"; do
  name="$(field "$row" 1)"
  [ "$name" = SSH_PRIVATE_KEY ] && continue
  [ -n "${!name:-}" ] || continue          # blank = keep whatever GitHub holds
  gh secret set "$name" --env "$ENV_NAME" --repo "$REPO" --body "${!name}"
  echo "   sec  $name"
done
# Read back and compare. A push that stops early is the failure mode that matters
# here — the deploy runs anyway, with blanks — so it must not be possible to end
# on "Done" while variables are missing.
echo
echo "==> verifying"
landed="$(gh api "repos/${REPO}/environments/${ENV_NAME}/variables?per_page=100" --jq '.variables[].name' 2>/dev/null || true)"
absent=()
for key in "${pushed[@]}"; do
  grep -qx "$key" <<<"$landed" || absent+=("$key")
done
if [ "${#absent[@]}" -gt 0 ]; then
  echo "   ${#absent[@]} variable(s) reported as pushed are NOT in GitHub:" >&2
  printf '     %s\n' "${absent[@]}" >&2
  exit 1
fi
echo "   ${#pushed[@]} variable(s) confirmed in GitHub"

echo
echo "Done. NODES, PB_URL, PB_BIND_IP, PB_DATA_DEVICE, PRIVATE_SUBNET, TUNNEL_TOKEN,"
echo "CF_ACCESS_* and the generated passwords are written by the workflows themselves."
