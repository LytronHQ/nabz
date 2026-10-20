#!/usr/bin/env bash
# pb_mail_test.sh — PocketBase's account emails are wired up (#627).
#
#   ./deploy/pb_mail_test.sh
#
# Production never sent a verification or password-reset email: no PocketBase
# SMTP, no app URL, and templates that linked to PocketBase's admin UI. It checks:
#   1. the users templates link to the web's own confirm pages, and login alerts
#      are off
#   2. remote-deploy.sh fills PocketBase's mail from the alerts' MailerSend
#      settings when no PB_SMTP_* is set: host, port, user, password, the web
#      URL as appURL, and no-reply@ on the alerts' domain as the sender
#   3. explicit PB_* values still win
#   4. setup-pocketbase.sh applies the templates, before the OAuth step, and
#      keeps the SMTP password and S3 secret off argv
#   5. the service accounts' login alerts are off in the schema
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
ran=0

# 1
body="$(bash -c ". '$HERE/pb-mail.sh'; pb_users_mail_body")"
for t in verification:confirm-verification resetPassword:confirm-password-reset confirmEmailChange:confirm-email-change; do
  key="${t%%:*}Template" page="${t#*:}"
  jq -e --arg k "$key" --arg p "{APP_URL}/auth/$page/{TOKEN}" '.[$k].body | contains($p)' <<<"$body" >/dev/null \
    || fail "$key does not link to {APP_URL}/auth/$page/{TOKEN}"
  ! jq -e --arg k "$key" '.[$k].body | contains("/_/")' <<<"$body" >/dev/null || fail "$key still links into PocketBase's admin UI"
done
[ "$(jq -r '.authAlert.enabled' <<<"$body")" = false ] || fail "users login alerts are not off"
ran=$((ran + 1))

# 2 and 3: run remote-deploy.sh's pocketbase_env on its own.
{ sed -n '/^kv() {/p' "$HERE/remote-deploy.sh"; sed -n '/^pocketbase_env() {/,/^}/p' "$HERE/remote-deploy.sh"; } > "$WORK/env.sh"
grep -q '^pocketbase_env()' "$WORK/env.sh" || fail "pocketbase_env not found in remote-deploy.sh"
penv() { env -i PATH="$PATH" PB_SUPERUSER_EMAIL=a@b PB_SUPERUSER_PASSWORD=x ENV_FILE=x "$@" bash -c ". '$WORK/env.sh'; pocketbase_env"; }
val() { sed -n "s/^$1='\\(.*\\)'\$/\\1/p" <<<"$2"; }
out="$(penv SMTP_HOST=smtp.mailersend.net SMTP_PORT=587 SMTP_USERNAME=u SMTP_PASSWORD=p SMTP_FROM=alerts@nabz.sh WEB_URL=https://nabz.sh)"
[ "$(val PB_SMTP_HOST "$out")" = smtp.mailersend.net ] || fail "PB_SMTP_HOST does not default to SMTP_HOST"
[ "$(val PB_SMTP_PORT "$out")" = 587 ] || fail "PB_SMTP_PORT does not default to SMTP_PORT"
[ "$(val PB_SMTP_USERNAME "$out")" = u ] || fail "PB_SMTP_USERNAME does not default to SMTP_USERNAME"
[ "$(val PB_SMTP_PASSWORD "$out")" = p ] || fail "PB_SMTP_PASSWORD does not default to SMTP_PASSWORD"
[ "$(val PB_APP_URL "$out")" = https://nabz.sh ] || fail "PB_APP_URL does not default to WEB_URL"
[ "$(val PB_SENDER_ADDRESS "$out")" = no-reply@nabz.sh ] || fail "PB_SENDER_ADDRESS is $(val PB_SENDER_ADDRESS "$out"), want no-reply@nabz.sh"
ran=$((ran + 1))

out="$(penv SMTP_HOST=a SMTP_FROM=alerts@nabz.sh WEB_URL=https://nabz.sh PB_SMTP_HOST=b PB_APP_URL=https://x PB_SENDER_ADDRESS=me@x)"
[ "$(val PB_SMTP_HOST "$out")" = b ] && [ "$(val PB_APP_URL "$out")" = https://x ] && [ "$(val PB_SENDER_ADDRESS "$out")" = me@x ] \
  || fail "explicit PB_* values do not win"
out="$(penv WEB_URL=https://nabz.sh)"
[ -z "$(val PB_SMTP_HOST "$out")" ] && [ -z "$(val PB_SENDER_ADDRESS "$out")" ] || fail "with no SMTP at all, nothing should be invented"
ran=$((ran + 1))

# 4
S="$HERE/setup-pocketbase.sh"
mail_line="$(grep -n '^pb_apply_users_mail ' "$S" | cut -d: -f1)"
oauth_line="$(grep -n '^pb_apply_oauth2 ' "$S" | cut -d: -f1)"
[ -n "$mail_line" ] || fail "setup-pocketbase.sh does not apply the mail templates"
[ "$mail_line" -lt "$oauth_line" ] || fail "the mail templates are applied after the OAuth step, which must stay last"
! grep -qE -- '--arg (smtpPass|s3Secret)' "$S" || fail "a secret is passed to jq on argv"
grep -q -- '--data-binary @- <<<"$settings_body"' "$S" || fail "the settings body is not sent on stdin"
ran=$((ran + 1))

# 5
[ "$(jq -r '.[] | select(.name=="service_accounts") | .authAlert.enabled' "$ROOT/infrastructure/pb_schema.json")" = false ] \
  || fail "service_accounts login alerts are still on"
ran=$((ran + 1))

[ "$ran" = 5 ] || fail "only $ran of 5 checks ran"
echo "pb_mail_test: all $ran checks passed"
