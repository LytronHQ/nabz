# shellcheck shell=bash
# pb-mail.sh — the account emails PocketBase sends for the users collection
# (#627): signup verification, password reset, email change. Sourced by
# setup-pocketbase.sh (every real environment) and e2e/setup.sh.
#
# PocketBase's default templates link to {APP_URL}/_/#/auth/confirm-…/{TOKEN},
# its own admin UI, which sits behind Cloudflare Access and is no page for a
# user. The web serves these instead, so the links point there:
#   /auth/confirm-verification/<token>
#   /auth/confirm-password-reset/<token>
#   /auth/confirm-email-change/<token>
# {APP_URL} is meta.appURL, which remote-deploy.sh sets to the web's URL.
#
# users is PocketBase's built-in collection and not in pb_schema.json, so this
# PATCHes it, like listRule and oauth2.

# Login alerts ("login from a new location") are off: every sign-in reaches
# PocketBase from the web server through the tunnel, never from the user's own
# browser, so the "location" is always ours and the alert would only confuse.
#
# Prints the users-collection PATCH body.
pb_users_mail_body() {
  local foot='<p><i>If you did not ask for this, you can ignore this email.</i></p><p>Thanks,<br/>{APP_NAME}</p>'
  jq -nc --arg foot "$foot" '{
    authAlert: { enabled: false },
    verificationTemplate: {
      subject: "Verify your {APP_NAME} email",
      body: ("<p>Hello,</p><p>Thanks for signing up for {APP_NAME}. Confirm your email address to finish:</p><p><a class=\"btn\" href=\"{APP_URL}/auth/confirm-verification/{TOKEN}\" target=\"_blank\" rel=\"noopener\">Verify email</a></p>" + $foot)
    },
    resetPasswordTemplate: {
      subject: "Reset your {APP_NAME} password",
      body: ("<p>Hello,</p><p>Someone asked to reset the password of your {APP_NAME} account. Choose a new one here:</p><p><a class=\"btn\" href=\"{APP_URL}/auth/confirm-password-reset/{TOKEN}\" target=\"_blank\" rel=\"noopener\">Reset password</a></p>" + $foot)
    },
    confirmEmailChangeTemplate: {
      subject: "Confirm your new {APP_NAME} email",
      body: ("<p>Hello,</p><p>Confirm this address as the new email of your {APP_NAME} account:</p><p><a class=\"btn\" href=\"{APP_URL}/auth/confirm-email-change/{TOKEN}\" target=\"_blank\" rel=\"noopener\">Confirm new email</a></p>" + $foot)
    }
  }'
}

# pb_apply_users_mail <pocketbase base url> <superuser token>
pb_apply_users_mail() {
  local base="$1" token="$2" code out
  out="$(mktemp)"
  code="$(pb_users_mail_body | curl -sS -o "$out" -w '%{http_code}' "$base/api/collections/users" -X PATCH \
    -H "Authorization: $token" -H 'Content-Type: application/json' --data-binary @-)"
  case "$code" in
    200) echo "   users mail templates link to {APP_URL}/auth/confirm-…";;
    *)   echo "   WARN: users mail templates PATCH got HTTP $code: $(jq -c '.data // .' "$out" 2>/dev/null || cat "$out")";;
  esac
  rm -f "$out"
}
