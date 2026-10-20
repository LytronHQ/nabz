#!/usr/bin/env bash
# pb_oauth_test.sh — deploy/pb-oauth.sh, the users.oauth2 block (#609).
#
#   ./deploy/pb_oauth_test.sh
#
# It checks:
#   1. no keys: OAuth is written OFF with no providers (an environment without
#      the keys behaves as before, and removing them turns sign-in off)
#   2. both pairs: github and google, with name/avatar mapped on create only
#   3. half a pair: that provider stays off with a warning, the other still on
#      (PocketBase rejects a provider without a secret, failing the whole PATCH)
#   4. endpoint overrides reach the provider (the e2e fake GitHub)
#   5. pb_apply_oauth2 PATCHes /api/collections/users with the token, and never
#      prints a secret
#   6. setup-pocketbase.sh sources the script and applies it
#   7. ...after every collection-level read or write of users: PocketBase < 0.36.8
#      blanks the in-memory client secrets when it serialises the collection, so
#      a later GET left production sign-in sending no secret (2026-10-19)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
ran=0

body() { # env assignments...  -> prints the PATCH body; stderr to $WORK/err
  env -i PATH="$PATH" "$@" bash -c '. "'"$HERE"'/pb-oauth.sh"; pb_oauth2_body' 2>"$WORK/err"
}

# 1
b="$(body)"
[ "$(jq -c '.oauth2 | [.enabled, .providers]' <<<"$b")" = '[false,[]]' ] || fail "no keys should write oauth2 off: $b"
ran=$((ran + 1))

# 2
b="$(body OAUTH_GITHUB_CLIENT_ID=gh-id OAUTH_GITHUB_CLIENT_SECRET=gh-secret \
          OAUTH_GOOGLE_CLIENT_ID=go-id OAUTH_GOOGLE_CLIENT_SECRET=go-secret)"
[ "$(jq -r '.oauth2.enabled' <<<"$b")" = true ] || fail "two pairs should enable oauth2"
[ "$(jq -c '[.oauth2.providers[] | [.name, .clientId, .clientSecret]]' <<<"$b")" = \
  '[["github","gh-id","gh-secret"],["google","go-id","go-secret"]]' ] || fail "providers wrong: $b"
[ "$(jq -c '.oauth2.mappedFields | [.name, .avatarURL]' <<<"$b")" = '["name","avatar"]' ] \
  || fail "name/avatar should be mapped: $b"
ran=$((ran + 1))

# 3
b="$(body OAUTH_GITHUB_CLIENT_ID=gh-id OAUTH_GOOGLE_CLIENT_ID=go-id OAUTH_GOOGLE_CLIENT_SECRET=go-secret)"
[ "$(jq -c '[.oauth2.providers[].name]' <<<"$b")" = '["google"]' ] || fail "half a github pair should leave only google: $b"
grep -q 'OAUTH_GITHUB_CLIENT_ID / _CLIENT_SECRET' "$WORK/err" || fail "half a pair should warn: $(cat "$WORK/err")"
ran=$((ran + 1))

# 4
b="$(body OAUTH_GITHUB_CLIENT_ID=a OAUTH_GITHUB_CLIENT_SECRET=b \
          OAUTH_GITHUB_AUTH_URL=http://fake/authorize OAUTH_GITHUB_TOKEN_URL=http://fake/token \
          OAUTH_GITHUB_USER_INFO_URL=http://fake/user)"
[ "$(jq -c '.oauth2.providers[0] | [.authURL, .tokenURL, .userInfoURL]' <<<"$b")" = \
  '["http://fake/authorize","http://fake/token","http://fake/user"]' ] || fail "overrides lost: $b"
ran=$((ran + 1))

# 5 — a stub curl records the request and answers like PocketBase
mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
# argv first, before the loop shifts it away: a secret there is readable by any
# user on the host via ps.
printf '%s\n' "$*" > "$REQ.argv"
method=GET url="" body="" out="" auth=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -d|--data-binary) body="$2"; shift 2 ;;
    -o) out="$2"; shift 2 ;;
    -H) case "$2" in Authorization:*) auth="$2";; esac; shift 2 ;;
    -w) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ "$body" = @- ] && body="$(cat)"
printf '%s\n%s\n%s\n%s\n' "$method" "$url" "$auth" "$body" > "$REQ"

printf '%s' "$body" > "$out"
printf 200
STUB
chmod +x "$WORK/bin/curl"
out="$(env -i PATH="$WORK/bin:$PATH" REQ="$WORK/req" \
  OAUTH_GITHUB_CLIENT_ID=gh-id OAUTH_GITHUB_CLIENT_SECRET=gh-secret-value \
  bash -c '. "'"$HERE"'/pb-oauth.sh"; pb_apply_oauth2 http://pb:8090 su-token')"
[ "$(sed -n 1p "$WORK/req")" = PATCH ] || fail "expected a PATCH, got $(sed -n 1p "$WORK/req")"
[ "$(sed -n 2p "$WORK/req")" = http://pb:8090/api/collections/users ] || fail "wrong url: $(sed -n 2p "$WORK/req")"
[ "$(sed -n 3p "$WORK/req")" = 'Authorization: su-token' ] || fail "token not sent"
[ "$out" = '   oauth2: github' ] || fail "unexpected output: $out"
! grep -q 'gh-secret-value' <<<"$out" || fail "a secret was printed"
[ "$(sed -n 4p "$WORK/req" | jq -r '.oauth2.providers[0].clientSecret')" = gh-secret-value ] \
  || fail "the secret did not reach the request body"
! grep -q 'gh-secret-value' "$WORK/req.argv" || fail "the secret was on curl's command line"
ran=$((ran + 1))

# 6
grep -q '^\. "\$APP_DIR/deploy/pb-oauth.sh"$' "$HERE/setup-pocketbase.sh" || fail "setup-pocketbase.sh does not source pb-oauth.sh"
grep -q '^pb_apply_oauth2 ' "$HERE/setup-pocketbase.sh" || fail "setup-pocketbase.sh does not apply oauth2"
for v in OAUTH_GITHUB_CLIENT_ID OAUTH_GITHUB_CLIENT_SECRET OAUTH_GOOGLE_CLIENT_ID OAUTH_GOOGLE_CLIENT_SECRET; do
  grep -q "kv $v " "$HERE/remote-deploy.sh" || fail "remote-deploy.sh does not pass $v to pocketbase.env"
done
ran=$((ran + 1))

# 7
apply_line="$(grep -n '^pb_apply_oauth2 ' "$HERE/setup-pocketbase.sh" | cut -d: -f1)"
users_lines="$(grep -n 'api/collections/users"' "$HERE/setup-pocketbase.sh" | cut -d: -f1)"
[ -n "$users_lines" ] || fail "no collection-level users access found; the check would prove nothing"
last_users="$(tail -1 <<<"$users_lines")"
[ "$apply_line" -gt "$last_users" ] \
  || fail "pb_apply_oauth2 (line $apply_line) runs before a users collection access (line $last_users); PocketBase < 0.36.8 then drops the client secrets from memory"
ran=$((ran + 1))

[ "$ran" = 7 ] || fail "only $ran of 7 checks ran"
echo "pb_oauth_test: all $ran checks passed"
