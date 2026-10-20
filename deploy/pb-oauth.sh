# shellcheck shell=bash
# pb-oauth.sh — sign in with GitHub and Google (#609): PocketBase's users.oauth2,
# built from the environment. Sourced by setup-pocketbase.sh (every real
# environment) and e2e/setup.sh, so both configure it the same way.
#
#   OAUTH_GITHUB_CLIENT_ID / OAUTH_GITHUB_CLIENT_SECRET
#   OAUTH_GOOGLE_CLIENT_ID / OAUTH_GOOGLE_CLIENT_SECRET
#
# The values live in Bitwarden, never in the repo. A provider is on only when both
# halves are set, and OAuth as a whole is off when none is, so an environment
# without the keys behaves exactly as before. Every run writes the whole block, so
# removing a pair from Bitwarden turns that provider off on the next deploy.
#
# OAUTH_<P>_AUTH_URL / _TOKEN_URL / _USER_INFO_URL override the provider's
# endpoints. Only the e2e stack sets them, to point PocketBase's real github
# provider at a fake one in the fixture.
#
# users is PocketBase's built-in collection and is not in pb_schema.json, so the
# schema import never touches this; it is PATCHed here instead, like listRule.

# Prints the users-collection PATCH body. Warnings go to stderr.
pb_oauth2_body() {
  local providers='[]' p upper id secret v_id v_secret v_auth v_token v_info
  for p in github google; do
    upper="$(printf '%s' "$p" | tr '[:lower:]' '[:upper:]')"
    v_id="OAUTH_${upper}_CLIENT_ID" v_secret="OAUTH_${upper}_CLIENT_SECRET"
    v_auth="OAUTH_${upper}_AUTH_URL" v_token="OAUTH_${upper}_TOKEN_URL" v_info="OAUTH_${upper}_USER_INFO_URL"
    id="${!v_id:-}" secret="${!v_secret:-}"
    if [ -z "$id" ] && [ -z "$secret" ]; then continue; fi
    if [ -z "$id" ] || [ -z "$secret" ]; then
      # Half a pair would be refused by PocketBase and fail the whole PATCH, taking
      # the other provider down with it. Leave just this one off, and say why.
      echo "   WARN: only one of OAUTH_${upper}_CLIENT_ID / _CLIENT_SECRET is set; ${p} sign-in stays off" >&2
      continue
    fi
    # The secret reaches jq through its environment, not argv, where any user on
    # the host could read it in `ps` while jq runs.
    providers="$(OAUTH_ID="$id" OAUTH_SECRET="$secret" jq -c \
      --arg name "$p" --arg auth "${!v_auth:-}" --arg token "${!v_token:-}" --arg info "${!v_info:-}" \
      '. + [{name:$name, clientId:$ENV.OAUTH_ID, clientSecret:$ENV.OAUTH_SECRET,
             authURL:$auth, tokenURL:$token, userInfoURL:$info}]' <<<"$providers")"
  done
  # mappedFields fill name and avatar when PocketBase CREATES the user, and never
  # again. The callback used to copy them on every OAuth sign-in, overwriting a
  # name the user had since changed.
  jq -nc --argjson p "$providers" '{oauth2: {
    enabled: ($p | length > 0),
    providers: $p,
    mappedFields: {id: "", name: "name", username: "", avatarURL: "avatar"}
  }}'
}

# pb_apply_oauth2 <pocketbase base url> <superuser token>
pb_apply_oauth2() {
  local base="$1" token="$2" body code out
  body="$(pb_oauth2_body)"
  out="$(mktemp)"
  # The body carries the client secrets: stdin, not argv (see above).
  code="$(curl -sS -o "$out" -w '%{http_code}' "$base/api/collections/users" -X PATCH \
    -H "Authorization: $token" -H 'Content-Type: application/json' --data-binary @- <<<"$body")"
  case "$code" in
    200) echo "   oauth2: $(jq -r '.oauth2.providers | if length == 0 then "off" else (map(.name) | join(", ")) end' "$out")";;
    *)   echo "   WARN: users oauth2 PATCH got HTTP $code: $(jq -c '.data // .' "$out" 2>/dev/null || cat "$out")";;
  esac
  rm -f "$out"
}
