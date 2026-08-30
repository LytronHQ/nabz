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

up() {
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
  seed_record service_accounts \
    "{\"email\":\"$WORKER_EMAIL\",\"password\":\"$WORKER_PASS\",\"passwordConfirm\":\"$WORKER_PASS\",\"role\":\"worker\",\"verified\":true,\"emailVisibility\":false}" \
    "worker service account"
  seed_record service_accounts \
    "{\"email\":\"$EVAL_EMAIL\",\"password\":\"$EVAL_PASS\",\"passwordConfirm\":\"$EVAL_PASS\",\"role\":\"evaluator\",\"verified\":true,\"emailVisibility\":false}" \
    "evaluator service account"

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
  echo "==> tearing down the e2e stack (+ volumes)"
  "${COMPOSE[@]}" down -v
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 [up|down]"; exit 2 ;;
esac
