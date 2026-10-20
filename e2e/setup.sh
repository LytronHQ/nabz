#!/usr/bin/env bash
# Bring the ephemeral e2e stack up (and bootstrap PocketBase) or tear it down.
# All credentials are throwaway LOCAL test values with in-file defaults.
#
#   e2e/setup.sh up     # build + start the stack, seed PB, wait until ready
#   e2e/setup.sh down   # stop the stack and delete its volumes
#
# Run from anywhere; paths resolve relative to the repo.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE=(docker compose -f "$HERE/docker-compose.e2e.yml")

PB_PORT="${E2E_PB_PORT:-8390}"
WEB_PORT="${E2E_WEB_PORT:-4390}"
PB="http://127.0.0.1:${PB_PORT}"
WEB="http://127.0.0.1:${WEB_PORT}"

SU_EMAIL="${E2E_SUPERUSER_EMAIL:-admin@e2e.local}"
SU_PASS="${E2E_SUPERUSER_PASSWORD:-e2e-superuser-pass}"
USER_EMAIL="${E2E_USER_EMAIL:-user@e2e.local}"
USER_PASS="${E2E_USER_PASSWORD:-e2e-user-pass}"
# Listed in the web's ADMIN_EMAILS (docker-compose.e2e.yml), so /admin/usage is
# under test without changing what the shared dashboard user sees.
ADMIN_EMAIL="${E2E_ADMIN_EMAIL:-staff@e2e.local}"
ADMIN_PASS="${E2E_ADMIN_PASSWORD:-e2e-staff-pass}"
WORKER_EMAIL="${E2E_WORKER_USERNAME:-worker@e2e.local}"
WORKER_PASS="${E2E_WORKER_PASSWORD:-worker-e2e-pass}"
EVAL_EMAIL="${E2E_EVALUATOR_USERNAME:-evaluator@e2e.local}"
EVAL_PASS="${E2E_EVALUATOR_PASSWORD:-evaluator-e2e-pass}"

json_get() { python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))"; }

wait_http() { # url label tries
  local url="$1" label="$2" tries="${3:-60}"
  printf '   waiting for %s ' "$label"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then echo "ok"; return 0; fi
    printf '.'; sleep 2
  done
  echo " TIMEOUT"; return 1
}

su_token() {
  curl -fsS "$PB/api/collections/_superusers/auth-with-password" \
    -H 'Content-Type: application/json' \
    --data "{\"identity\":\"$SU_EMAIL\",\"password\":\"$SU_PASS\"}" | json_get token
}

seed_record() { # collection json-body label  (uses $TOKEN); 200/400(exists) both ok
  local coll="$1" body="$2" label="$3" code
  code="$(curl -sS -o /tmp/e2e_seed.json -w '%{http_code}' \
    "$PB/api/collections/$coll/records" -X POST \
    -H "Authorization: $TOKEN" -H 'Content-Type: application/json' --data "$body")"
  case "$code" in
    200 | 201) echo "   seeded $label" ;;
    400) echo "   $label already exists" ;;
    *) echo "   WARN seeding $label -> HTTP $code: $(cat /tmp/e2e_seed.json)" ;;
  esac
}

# Web Push keys for the evaluator and web (#602), minted once per checkout and
# kept in a gitignored file: a new pair on every `up` would orphan any
# subscription a manual test made against the previous one.
vapid_keys() {
  local f="$HERE/.vapid.env"
  [ -s "$f" ] || "$ROOT/deploy/vapid-keys.sh" > "$f"
  E2E_VAPID_PUBLIC_KEY="$(sed -n 's/^VAPID_PUBLIC_KEY=//p' "$f")"
  E2E_VAPID_PRIVATE_KEY="$(sed -n 's/^VAPID_PRIVATE_KEY=//p' "$f")"
  export E2E_VAPID_PUBLIC_KEY E2E_VAPID_PRIVATE_KEY
}

# The PocketBase version e2e builds (#613): production's, from the vars file
# production deploys with, unless E2E_PB_VERSION says otherwise (to try an
# upgrade on e2e before production). One source, so the two cannot drift.
pb_version() {
  if [ -z "${E2E_PB_VERSION:-}" ]; then
    E2E_PB_VERSION="$(sed -n 's/^PB_VERSION=//p' "$ROOT/deploy/environments/production.vars" | tr -d "\"' ")"
  fi
  [ -n "$E2E_PB_VERSION" ] || { echo "no PB_VERSION in deploy/environments/production.vars" >&2; exit 1; }
  export E2E_PB_VERSION
}

up() {
  pb_version
  if [ "$E2E_PB_VERSION" = "$(sed -n 's/^PB_VERSION=//p' "$ROOT/deploy/environments/production.vars")" ]; then
    echo "==> PocketBase $E2E_PB_VERSION (production's: deploy/environments/production.vars)"
  else
    echo "==> PocketBase $E2E_PB_VERSION (E2E_PB_VERSION; production runs another version)"
  fi
  vapid_keys
  echo "==> building + starting the e2e stack"
  "${COMPOSE[@]}" up -d --build

  wait_http "$PB/api/health" "pocketbase :$PB_PORT" 40

  echo "==> ensuring superuser ($SU_EMAIL)"
  "${COMPOSE[@]}" exec -T pocketbase /usr/local/bin/pocketbase superuser upsert "$SU_EMAIL" "$SU_PASS" --dir /pb_data \
    || "${COMPOSE[@]}" exec -T pocketbase pocketbase superuser upsert "$SU_EMAIL" "$SU_PASS" --dir /pb_data

  TOKEN="$(su_token)"
  [ -n "$TOKEN" ] || { echo "superuser auth failed"; exit 1; }

  echo "==> importing schema (additive)"
  python3 -c "import json;print(json.dumps({'deleteMissing':False,'collections':json.load(open('$ROOT/infrastructure/pb_schema.json'))}))" \
    | curl -fsS "$PB/api/collections/import" -X PUT \
        -H "Authorization: $TOKEN" -H 'Content-Type: application/json' --data-binary @- >/dev/null
  echo "   schema imported"

  echo "==> seeding accounts"
  seed_record users \
    "{\"email\":\"$USER_EMAIL\",\"password\":\"$USER_PASS\",\"passwordConfirm\":\"$USER_PASS\",\"name\":\"E2E User\",\"verified\":true}" \
    "dashboard user ($USER_EMAIL)"
  seed_record users \
    "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\",\"passwordConfirm\":\"$ADMIN_PASS\",\"name\":\"E2E Staff\",\"verified\":true}" \
    "admin user ($ADMIN_EMAIL)"
  seed_record service_accounts \
    "{\"email\":\"$WORKER_EMAIL\",\"password\":\"$WORKER_PASS\",\"passwordConfirm\":\"$WORKER_PASS\",\"role\":\"worker\",\"verified\":true,\"emailVisibility\":false}" \
    "worker service account"
  seed_record service_accounts \
    "{\"email\":\"$EVAL_EMAIL\",\"password\":\"$EVAL_PASS\",\"passwordConfirm\":\"$EVAL_PASS\",\"role\":\"evaluator\",\"verified\":true,\"emailVisibility\":false}" \
    "evaluator service account"

  # Same rule deploy/setup-pocketbase.sh sets in every real environment. Without
  # it the web service account counts 0 users, and /admin/usage showed "Total
  # users 0" beside "Active users 1".
  echo "==> setting users.listRule for /admin/usage"
  curl -fsS -o /dev/null "$PB/api/collections/users" -X PATCH \
    -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
    --data '{"listRule":"id = @request.auth.id || @request.auth.collectionName = \"service_accounts\""}'
  echo "   users.listRule set"

  # Sign in with GitHub (#609), configured by the same script as every real
  # environment, with the provider's endpoints moved to the fixture's fake GitHub.
  # The browser follows authURL, so it is the host port; PocketBase calls the
  # token and user endpoints itself, on the compose network.
  echo "==> users.oauth2 (fake GitHub in the fixture)"
  local fixture_host="http://127.0.0.1:${E2E_FIXTURE_PORT:-8788}"
  (
    export OAUTH_GITHUB_CLIENT_ID=e2e-client OAUTH_GITHUB_CLIENT_SECRET=e2e-only-not-a-secret
    export OAUTH_GITHUB_AUTH_URL="$fixture_host/oauth/github/authorize"
    export OAUTH_GITHUB_TOKEN_URL=http://fixture:8080/oauth/github/token
    export OAUTH_GITHUB_USER_INFO_URL=http://fixture:8080/oauth/github/user
    # shellcheck source=../deploy/pb-oauth.sh
    . "$ROOT/deploy/pb-oauth.sh"
    pb_apply_oauth2 "$PB" "$TOKEN"
  )

  # Account emails (#627), as in every real environment but into the stack's
  # mail catcher: SMTP and the app URL the links are built from, then the same
  # templates production uses.
  echo "==> PocketBase mail -> mailpit, links -> $WEB"
  curl -fsS -o /dev/null "$PB/api/settings" -X PATCH \
    -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
    --data "{\"meta\":{\"appURL\":\"$WEB\",\"senderAddress\":\"no-reply@e2e.local\",\"senderName\":\"nabz\"},\"smtp\":{\"enabled\":true,\"host\":\"mail\",\"port\":1025,\"tls\":false,\"username\":\"\",\"password\":\"\"}}"
  # shellcheck source=../deploy/pb-mail.sh
  . "$ROOT/deploy/pb-mail.sh"
  pb_apply_users_mail "$PB" "$TOKEN"

  # A label for the zone the e2e worker reports (#311), so the display-name
  # decoupling is exercised against a code that differs from its label.
  seed_record zones \
    "{\"code\":\"e2e\",\"group_code\":\"test\",\"group_name\":\"Testing\",\"display_name\":\"E2E Region\",\"enabled\":true,\"sort_order\":10}" \
    "e2e zone label"

  wait_http "$WEB/signin" "web :$WEB_PORT" 60
  echo
  echo "e2e stack ready:"
  echo "   web         $WEB"
  echo "   pocketbase  $PB   (admin $SU_EMAIL / $SU_PASS)"
  echo "   dashboard   $USER_EMAIL / $USER_PASS"
}

down() {
  pb_version
  echo "==> tearing down the e2e stack (+ volumes)"
  "${COMPOSE[@]}" down -v
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  pb-version) pb_version; echo "$E2E_PB_VERSION" ;;
  *) echo "usage: $0 [up|down|pb-version]"; exit 2 ;;
esac
