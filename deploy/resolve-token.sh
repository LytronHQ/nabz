# Sourced, not run. Resolves BWS_ACCESS_TOKEN for $ENV_NAME.
#
# Tokens are per machine account, so working across environments means holding
# two. Keeping them in a gitignored .env as BWS_ACCESS_TOKEN_PRODUCTION and
# BWS_ACCESS_TOKEN_STAGING means never exporting anything by hand, and never
# running a command against the wrong environment because the export was stale.
# A plain BWS_ACCESS_TOKEN in the environment still wins, which is what CI sets.

if [ -z "${BWS_ACCESS_TOKEN:-}" ]; then
  _envfile="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env"
  # shellcheck disable=SC1090
  [ -f "$_envfile" ] && { set -a; . "$_envfile"; set +a; }
  _per_env="BWS_ACCESS_TOKEN_$(printf '%s' "${ENV_NAME:-}" | tr '[:lower:]' '[:upper:]')"
  [ -n "${!_per_env:-}" ] && export BWS_ACCESS_TOKEN="${!_per_env}"
  unset _envfile _per_env
fi
