#!/usr/bin/env bash
# bws_env_test.sh — bws-env.sh against a stub Bitwarden, checking the SOURCED
# result rather than the text.
#
#   ./deploy/bws_env_test.sh
#
# This script composes the configuration for every deploy, every environment. A
# regression here does not fail a check: it fails a production deploy, and the
# failure looks like a missing config value rather than like this script. It had
# no test of its own, which is why the engine underneath could not safely be
# replaced by the ops `secrets` module.
#
# The comparison is deliberately semantic. What callers do with the output is
# `set -a; . file`, so what matters is the variables that exist afterwards and
# their values — not the order of the lines, and not whether a key appears once
# or twice with the later winning.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# --- a fixture deploy/ tree -------------------------------------------------
FIX="$WORK/deploy"; mkdir -p "$FIX/environments" "$WORK/bin"
# The scripts under test fetch the module before using it. In a fixture that
# fetch is a no-op: the caller is what is under test here, and the real fetch
# has its own test (deploy/ops_vendor_test.sh).
printf '#!/usr/bin/env bash\nexit 0\n' > "$FIX/ops-fetch.sh"
chmod +x "$FIX/ops-fetch.sh"

ln -s "$HERE/bws-env.sh"       "$FIX/bws-env.sh"
ln -s "$HERE/resolve-token.sh" "$FIX/resolve-token.sh"
# The module is fetched, not committed; the fixture links to the fetched copy.
"$HERE/ops-fetch.sh" --check >/dev/null 2>&1 || "$HERE/ops-fetch.sh" >/dev/null
mkdir -p "$FIX/.ops"
ln -s "$HERE/.ops/secrets.sh" "$FIX/.ops/secrets.sh"

cat > "$FIX/environments/testenv.vars" <<'EOF'
# a comment, and a blank line follow

BWS_PROJECT_ID=proj-env
BWS_SHARED_PROJECT_ID=proj-shared
PB_VERSION=0.28.4
# lowest precedence: the shared project overrides this one
SMTP_HOST=vars.example.com
# nothing overrides this one
SERVER_PREFIX=nabz-test
EOF
# `prod` is an alias for production, so the alias needs a file to find.
sed 's/^SERVER_PREFIX=.*/SERVER_PREFIX=nabz-prod/' "$FIX/environments/testenv.vars" \
  > "$FIX/environments/production.vars"

# --- a stub bws -------------------------------------------------------------
# Values chosen to break naive quoting: spaces, a newline, a single quote, a $,
# and backticks. An SSH key and a cron expression are the real cases.
cat > "$WORK/bin/bws" <<'EOF'
#!/usr/bin/env bash
# bws secret list <project> --output json [--color no]
set -euo pipefail
[ "${1:-}" = "secret" ] && [ "${2:-}" = "list" ] || { echo "stub bws: $*" >&2; exit 64; }
[ -n "${BWS_ACCESS_TOKEN:-}" ] || { echo "stub bws: no BWS_ACCESS_TOKEN" >&2; exit 1; }
case "$3" in
  proj-shared) cat <<'JSON'
[{"key":"SMTP_HOST","value":"shared.example.com"},
 {"key":"SMTP_PASSWORD","value":"it's a \"quoted\" $PATH `whoami` pass"},
 {"key":"CF_ACCOUNT_ID","value":"acct123"},
 {"key":"SSH_PRIVATE_KEY","value":"-----BEGIN KEY-----\nline two\n-----END KEY-----"}]
JSON
  ;;
  proj-env) cat <<'JSON'
[{"key":"SMTP_HOST","value":"env.example.com"},
 {"key":"PB_SUPERUSER_PASSWORD","value":"env only"},
 {"key":"CRON","value":"*/5 * * * *"}]
JSON
  ;;
  proj-empty) echo '[]' ;;
  *) echo "stub bws: unknown project $3" >&2; exit 1 ;;
esac
EOF
chmod +x "$WORK/bin/bws"

run() { # [env-name] [--stdout]
  env PATH="$WORK/bin:$PATH" BWS_ACCESS_TOKEN=stub-token \
    bash "$FIX/bws-env.sh" "$@"
}

# What `set -a; . file` actually leaves behind. declare -p quotes unambiguously,
# so a value containing a newline stays one comparable line.
sourced() { # file
  env -i bash -c '
    set -a; . "$1"; set +a
    for v in $(compgen -e | LC_ALL=C sort); do
      case "$v" in PWD|SHLVL|_|OLDPWD) continue ;; esac
      declare -p "$v"
    done' _ "$1"
}

echo "== file mode: writes 0600, prints the path on stdout =="
out="$(run testenv)" || fail "run failed"
[ "$out" = "$FIX/.materialized/testenv.env" ] \
  || fail "expected the materialized path on stdout, got '$out'"
mode="$(stat -c '%a' "$out")"
[ "$mode" = "600" ] || fail "materialized file is mode $mode, not 600"

echo "== precedence: vars < shared project < environment project =="
env_after="$WORK/after"; sourced "$out" > "$env_after"
want() { # KEY VALUE
  grep -qxF "declare -x $1=\"$2\"" "$env_after" \
    || fail "expected $1=$2, got: $(grep "^declare -x $1=" "$env_after" || echo '(absent)')"
}
want SMTP_HOST env.example.com          # env beats shared beats vars
want SERVER_PREFIX nabz-test            # vars survive when nothing overrides
want PB_VERSION 0.28.4
want PB_SUPERUSER_PASSWORD "env only"

echo "== awkward values survive being sourced =="
grep -q "^declare -x SMTP_PASSWORD=" "$env_after" || fail "SMTP_PASSWORD missing"
got_pw="$(env -i bash -c 'set -a; . "$1"; set +a; printf %s "$SMTP_PASSWORD"' _ "$out")"
[ "$got_pw" = 'it'"'"'s a "quoted" $PATH `whoami` pass' ] \
  || fail "SMTP_PASSWORD came back mangled: [$got_pw]"
got_key="$(env -i bash -c 'set -a; . "$1"; set +a; printf %s "$SSH_PRIVATE_KEY"' _ "$out")"
[ "$(printf '%s' "$got_key" | wc -l)" = "2" ] \
  || fail "SSH_PRIVATE_KEY lost its newlines: [$got_key]"
got_cron="$(env -i bash -c 'set -a; . "$1"; set +a; printf %s "$CRON"' _ "$out")"
[ "$got_cron" = '*/5 * * * *' ] || fail "CRON came back as [$got_cron] — it was globbed"

echo "== PB_BACKUP_S3_ENDPOINT is derived from CF_ACCOUNT_ID =="
want PB_BACKUP_S3_ENDPOINT https://acct123.r2.cloudflarestorage.com

echo "== the project ids are structure, not config: they stay out =="
for k in BWS_PROJECT_ID BWS_SHARED_PROJECT_ID; do
  grep -q "^declare -x $k=" "$env_after" && fail "$k leaked into the output"
done

echo "== --stdout prints and writes nothing =="
rm -rf "$FIX/.materialized"
sout="$(run testenv --stdout)" || fail "--stdout run failed"
[ ! -d "$FIX/.materialized" ] || fail "--stdout left files on disk"
printf '%s\n' "$sout" > "$WORK/stdout.env"
sourced "$WORK/stdout.env" > "$WORK/after2"
diff -u "$env_after" "$WORK/after2" >/dev/null \
  || fail "--stdout and the file disagree: $(diff -u "$env_after" "$WORK/after2" | head -5)"

echo "== 'prod' is an alias for production =="
pout="$(run prod)" || fail "prod alias failed"
[ "$pout" = "$FIX/.materialized/production.env" ] \
  || fail "prod should materialize production.env, got '$pout'"
grep -qxF 'declare -x SERVER_PREFIX="nabz-prod"' <(sourced "$pout") \
  || fail "the prod alias read the wrong vars file"

echo "== a project with no secrets is fatal =="
sed -i 's/^BWS_PROJECT_ID=.*/BWS_PROJECT_ID=proj-empty/' "$FIX/environments/testenv.vars"
if run testenv >/dev/null 2>&1; then fail "an empty project should be fatal — a wrong id reads exactly like this"; fi
sed -i 's/^BWS_PROJECT_ID=.*/BWS_PROJECT_ID=proj-env/' "$FIX/environments/testenv.vars"

echo "== no access token is fatal, and says which environment =="
err="$(env PATH="$WORK/bin:$PATH" BWS_ACCESS_TOKEN= HOME="$WORK" \
        bash "$FIX/bws-env.sh" testenv 2>&1 >/dev/null || true)"
grep -qi "BWS_ACCESS_TOKEN" <<<"$err" || fail "the error should name BWS_ACCESS_TOKEN: $err"

echo "== an unknown environment is fatal =="
if run nosuchenv >/dev/null 2>&1; then fail "a missing .vars file should be fatal"; fi

echo "PASS"
