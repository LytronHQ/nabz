#!/usr/bin/env bash
#
# Bootstrap a bare Ubuntu/Debian host as the monitors POCKETBASE node: run
# PocketBase in Docker (deploy/pocketbase.yml) and seed it — superuser, schema
# import, and the worker/evaluator service accounts. Idempotent; re-run any time.
#
#   curl -fsSL .../deploy/setup-pocketbase.sh | sudo bash   # first run creates env, stops
#
# Overridable via env: REPO_URL, APP_DIR, ENV_FILE, PB_PORT
set -euo pipefail

# SSH forwards the client's LC_*/LANG; pin one that always exists (minimal images
# lack en_GB.UTF-8) so apt/dpkg stay quiet.
export LC_ALL=C.UTF-8 LANG=C.UTF-8

REPO_URL="${REPO_URL:-https://github.com/LytronHQ/nabz.git}"
APP_DIR="${APP_DIR:-/opt/monitors}"
ENV_FILE="${ENV_FILE:-/etc/monitors/pocketbase.env}"
PB_PORT="${PB_PORT:-8090}"

[ "$(id -u)" = "0" ] || { echo "Please run as root (or with sudo)."; exit 1; }

echo "==> curl + git + jq + Docker"
command -v curl   >/dev/null 2>&1 || { apt-get update -y && apt-get install -y curl ca-certificates; }
command -v git    >/dev/null 2>&1 || { apt-get update -y && apt-get install -y git; }
command -v jq     >/dev/null 2>&1 || { apt-get update -y && apt-get install -y jq; }
command -v docker >/dev/null 2>&1 || { curl -fsSL https://get.docker.com | sh; systemctl enable --now docker; }
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ] && getent group docker >/dev/null 2>&1; then
  usermod -aG docker "$SUDO_USER"
fi

if [ "${SKIP_CLONE:-0}" = "1" ]; then
  [ -d "$APP_DIR" ] || { echo "SKIP_CLONE=1 but $APP_DIR is missing"; exit 1; }
  echo "==> Using code at $APP_DIR (pushed from laptop)"
else
  echo "==> Code -> $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone --depth 1 "$REPO_URL" "$APP_DIR"; fi
fi

if [ ! -f "$ENV_FILE" ]; then
  mkdir -p "$(dirname "$ENV_FILE")"
  cp "$APP_DIR/deploy/pocketbase.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo; echo ">> Created $ENV_FILE — fill in PB_SUPERUSER_* (+ seed creds), then re-run."
  exit 1
fi
set -a; . "$ENV_FILE"; set +a
: "${PB_SUPERUSER_EMAIL:?set PB_SUPERUSER_EMAIL in $ENV_FILE}"
: "${PB_SUPERUSER_PASSWORD:?set PB_SUPERUSER_PASSWORD in $ENV_FILE}"

if [ ! -f /etc/monitors/.hardened ]; then
  bash "$APP_DIR/deploy/harden.sh" && touch /etc/monitors/.hardened
fi

# --- pb_data storage ---------------------------------------------------------
# On prod, pb_data lives on an attached Hetzner Volume, never the boot disk
# (#331) — a Hetzner disk resize is one-way and permanently locks the server
# plan, whereas a Volume grows independently. PB_DATA_DEVICE is printed by
# provision.sh and carried through the environment's Bitwarden project; "auto" finds the single attached
# Hetzner volume. Unset (dev, or a plain `compose up`) keeps the local docker
# volume, so nothing here changes for a libvirt VM.
PB_DATA_MOUNT="${PB_DATA_MOUNT:-/mnt/pb-data}"
if [ -n "${PB_DATA_DEVICE:-}" ]; then
  dev="$PB_DATA_DEVICE"
  if [ "$dev" = "auto" ]; then
    # Hetzner exposes attached volumes as /dev/disk/by-id/scsi-0HC_Volume_<id>.
    mapfile -t found < <(ls -1 /dev/disk/by-id/scsi-0HC_Volume_* 2>/dev/null || true)
    [ "${#found[@]}" -eq 1 ] || {
      echo "PB_DATA_DEVICE=auto found ${#found[@]} attached Hetzner volumes: ${found[*]:-none}"
      echo "Refusing to guess which one holds pb_data — set PB_DATA_DEVICE to the exact device path."
      exit 1
    }
    dev="${found[0]}"
  fi
  [ -b "$dev" ] || { echo "PB_DATA_DEVICE=$dev is not a block device — is the volume attached?"; exit 1; }

  # Format ONLY a genuinely blank device. An existing filesystem is data.
  if ! blkid "$dev" >/dev/null 2>&1; then
    echo "==> $dev has no filesystem — creating ext4"
    mkfs.ext4 -q -L pb-data "$dev"
  fi

  mkdir -p "$PB_DATA_MOUNT"
  # nofail: a missing volume must not leave the host unbootable. The guard below
  # is what stops PocketBase starting against an empty directory instead.
  if ! grep -q "[[:space:]]${PB_DATA_MOUNT}[[:space:]]" /etc/fstab; then
    echo "$dev  $PB_DATA_MOUNT  ext4  discard,nofail,defaults  0 2" >> /etc/fstab
    echo "   added $PB_DATA_MOUNT to /etc/fstab (nofail)"
  fi
  mountpoint -q "$PB_DATA_MOUNT" || mount "$PB_DATA_MOUNT"
  mountpoint -q "$PB_DATA_MOUNT" || { echo "failed to mount $dev at $PB_DATA_MOUNT"; exit 1; }

  # The failure this guards against: the mount silently not being there, so PB
  # starts against an empty directory, creates a fresh database, and answers its
  # liveness probe perfectly while every account and monitor is missing.
  if [ -f "$PB_DATA_MOUNT/data.db" ]; then
    echo "   $PB_DATA_MOUNT mounted from $dev (existing data.db present)"
  else
    echo "   $PB_DATA_MOUNT mounted from $dev (empty — first run on this volume)"
  fi
  export PB_DATA_PATH="$PB_DATA_MOUNT"
  # Persist it where EVERY compose invocation on this host will see it — compose
  # reads `.env` from the compose file's own directory. Exporting it only for
  # this script is not enough: upgrade.sh, the runbook's "PocketBase down ->
  # docker compose up -d" restart, and any manual invocation would each resolve
  # ${PB_DATA_PATH:-pb_data} to the NAMED VOLUME and quietly start PocketBase on
  # an empty database — which answers its liveness probe perfectly while every
  # account, monitor and incident is missing. push_code wipes $APP_DIR on each
  # deploy, so this is rewritten here every time.
  printf '# Written by setup-pocketbase.sh — pb_data lives on the attached volume (#331).\nPB_DATA_PATH=%s\n' \
    "$PB_DATA_MOUNT" > "$APP_DIR/deploy/.env"
else
  echo "==> pb_data on the local docker volume (no PB_DATA_DEVICE set)"
  # No device configured: make sure a stale pin from a previous run can't send
  # compose at a path that is no longer mounted.
  rm -f "$APP_DIR/deploy/.env"
fi

# Bind PocketBase to the private network address in prod (#338) so it never
# listens on a public interface; unset = 0.0.0.0 for dev.
export PB_BIND_IP="${PB_BIND_IP:-}"
# Every call below has to go to the address the port is actually PUBLISHED on.
# pocketbase.yml maps '${PB_BIND_IP:-0.0.0.0}:8090:8090', so on a real node —
# where PB_BIND_IP is the private network address — 127.0.0.1:8090 is not bound
# at all and every request from this script is refused. The container's own
# healthcheck still passes, because it runs inside the container, so the symptom
# is a healthy PocketBase that the deploy insists never came up.
# The private NIC has to exist before compose tries to BIND to it. pocketbase.yml
# publishes ${PB_BIND_IP}:8090:8090, so on a node whose interface was never
# configured this is not a retry loop like the worker's — it is an immediate
# "cannot assign requested address" on the first node of the deploy, naming
# neither the NIC nor cloud-init.
if [ -x "$APP_DIR/deploy/ensure-private-net.sh" ]; then
  PRIV_SUBNET="$(grep -E '^PRIVATE_SUBNET=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  PRIVATE_SUBNET="$PRIV_SUBNET" bash "$APP_DIR/deploy/ensure-private-net.sh"
fi

PB_ADDR="${PB_BIND_IP:-127.0.0.1}"

# The Cloudflare Tunnel is how the Workers-hosted web app reaches PocketBase
# without a public inbound port. Enabled by the presence of a tunnel token, so a
# dev box or a self-hosted web VM simply doesn't run it.
COMPOSE_PROFILES_ARG=()
if [ -n "${TUNNEL_TOKEN:-}" ]; then
  COMPOSE_PROFILES_ARG=(--profile tunnel)
  echo "==> Cloudflare Tunnel enabled (2 connectors)"
else
  echo "==> no TUNNEL_TOKEN — not starting the Cloudflare Tunnel"
fi

echo "==> docker compose up (PocketBase — building pinned image)"
cd "$APP_DIR"
docker compose -f deploy/pocketbase.yml "${COMPOSE_PROFILES_ARG[@]}" up -d --build

echo -n "==> waiting for PocketBase on ${PB_ADDR}:${PB_PORT} "
for _ in $(seq 1 60); do
  curl -fsS "http://${PB_ADDR}:${PB_PORT}/api/health" >/dev/null 2>&1 && break
  echo -n "."; sleep 2
done
echo
curl -fsS "http://${PB_ADDR}:${PB_PORT}/api/health" >/dev/null || {
  # Name the address. The container can be healthy on its own loopback while the
  # published address is somewhere else entirely, and that reads as "PocketBase
  # is down" when it is running perfectly.
  echo "PocketBase did not become healthy on ${PB_ADDR}:${PB_PORT}"
  echo "   published ports: $(docker compose -f deploy/pocketbase.yml ps --format '{{.Ports}}' 2>/dev/null || echo unknown)"
  exit 1
}

CID="$(docker compose -f deploy/pocketbase.yml ps -q pocketbase)"

# --- one-time: put the database in incremental auto-vacuum mode (#322) --------
# incremental_vacuum does nothing unless auto_vacuum is INCREMENTAL, and switching
# modes requires a full VACUUM to rewrite the file. That rewrite takes an
# exclusive lock and needs free disk equal to the database size, so it is free on
# a fresh instance and a multi-minute write stall on a populated one.
#
# Hence the guard: this only ever runs while the file is still small. A database
# that missed the window keeps working — maintenance.sh detects the mode and skips
# the vacuum with an explanation rather than silently doing nothing.
PB_CONVERT_MAX_BYTES="${PB_CONVERT_MAX_BYTES:-52428800}"   # 50 MiB
av_mode="$(docker exec "$CID" sqlite3 /pb_data/data.db 'PRAGMA auto_vacuum;' 2>/dev/null || echo '')"
if [ "$av_mode" = "2" ]; then
  echo "· auto_vacuum already INCREMENTAL"
elif [ -z "$av_mode" ]; then
  echo "· skipping auto_vacuum conversion (could not read the mode — old image without sqlite?)"
else
  db_bytes="$(docker exec "$CID" sh -c 'wc -c < /pb_data/data.db' 2>/dev/null | tr -d ' ' || echo 0)"
  if [ "${db_bytes:-0}" -le "$PB_CONVERT_MAX_BYTES" ]; then
    echo "==> converting to auto_vacuum=INCREMENTAL (one-time full VACUUM, db is ${db_bytes}B)"
    docker exec "$CID" sqlite3 -cmd '.timeout 30000' /pb_data/data.db \
      'PRAGMA auto_vacuum = INCREMENTAL; VACUUM;' \
      && echo "   converted (mode now $(docker exec "$CID" sqlite3 /pb_data/data.db 'PRAGMA auto_vacuum;'))" \
      || echo "   WARN: conversion failed — maintenance.sh will skip the vacuum and say so"
  else
    echo "!! auto_vacuum is '$av_mode', not INCREMENTAL, and this database is ${db_bytes}B."
    echo "   NOT converting: the full VACUUM that mode switch needs would lock the"
    echo "   database for the whole rewrite. Do it in a maintenance window by hand."
  fi
fi

echo "==> ensuring superuser ($PB_SUPERUSER_EMAIL)"
docker exec "$CID" /usr/local/bin/pocketbase superuser upsert "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD" --dir /pb_data \
  || docker exec "$CID" pocketbase superuser upsert "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD" --dir /pb_data

TOKEN="$(curl -fsS "http://${PB_ADDR}:${PB_PORT}/api/collections/_superusers/auth-with-password" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg i "$PB_SUPERUSER_EMAIL" --arg p "$PB_SUPERUSER_PASSWORD" '{identity:$i,password:$p}')" | jq -r '.token')"
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "superuser auth failed"; exit 1; }

# --- data migration: run BEFORE the import, not after ------------------------
# Tightening a min/max in pb_schema.json is a DATA MIGRATION, not a schema edit.
# PocketBase re-validates the WHOLE record on every save, including a partial
# PATCH that never mentions the field. So a stored row that violates a newly
# tightened constraint becomes permanently UNWRITABLE: the evaluator's
# `{"status": ...}` write and the worker's `last_checked` stamp both start
# returning HTTP 400 and never recover, which silently stops incidents from
# opening or resolving for that monitor. See docs/schema-constraints.md.
#
# So: normalise the data first, then tighten the constraint. Idempotent — a
# second run finds nothing, and a fresh instance has no `monitors` collection
# yet and simply skips.
echo "==> normalising rows that would violate tightened constraints"
backfill_min_interval() { # #319: raise sub-30s intervals to the floor
  local floor=30 round=0 ids n patched=0
  while [ "$round" -lt 50 ]; do
    round=$((round + 1))
    ids="$(curl -sS -G "http://${PB_ADDR}:${PB_PORT}/api/collections/monitors/records" \
      -H "Authorization: $TOKEN" \
      --data-urlencode "filter=interval > 0 && interval < ${floor}" \
      --data 'perPage=200&skipTotal=true&fields=id' 2>/dev/null \
      | jq -r '.items[]?.id' 2>/dev/null)" || true
    n="$(printf '%s' "$ids" | grep -c . || true)"
    [ "$n" -gt 0 ] || break
    for id in $ids; do
      curl -fsS "http://${PB_ADDR}:${PB_PORT}/api/collections/monitors/records/${id}" -X PATCH \
        -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
        -d "{\"interval\":${floor}}" >/dev/null || echo "   WARN: could not raise interval on $id"
      patched=$((patched + 1))
    done
  done
  if [ "$patched" -gt 0 ]; then
    echo "   raised $patched monitor(s) to the ${floor}s interval floor (#319)"
  else
    echo "   no rows below the ${floor}s interval floor"
  fi
}
backfill_min_interval

echo "==> importing schema (additive; deleteMissing=false)"
jq -nc --slurpfile c "$APP_DIR/infrastructure/pb_schema.json" '{deleteMissing:false, collections:$c[0]}' \
  | curl -fsS "http://${PB_ADDR}:${PB_PORT}/api/collections/import" -X PUT \
      -H "Authorization: $TOKEN" -H 'Content-Type: application/json' --data-binary @- >/dev/null
echo "   schema imported"

seed_sa() { # email password role
  local email="$1" pass="$2" role="$3"
  [ -n "$email" ] && [ -n "$pass" ] || { echo "   skip $role (no seed creds)"; return 0; }
  local code
  code="$(curl -sS -o /tmp/sa.json -w '%{http_code}' \
    "http://${PB_ADDR}:${PB_PORT}/api/collections/service_accounts/records" -X POST \
    -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg e "$email" --arg p "$pass" --arg r "$role" \
        '{email:$e,password:$p,passwordConfirm:$p,role:$r,verified:true,emailVisibility:false}')")"
  case "$code" in
    200|201) echo "   created $role account ($email)";;
    400)     echo "   $role account already exists ($email)";;
    *)       echo "   WARN: seeding $role got HTTP $code: $(cat /tmp/sa.json)";;
  esac
}
echo "==> seeding service accounts"
seed_sa "${SEED_WORKER_USERNAME:-}"    "${SEED_WORKER_PASSWORD:-}"    worker
seed_sa "${SEED_EVALUATOR_USERNAME:-}" "${SEED_EVALUATOR_PASSWORD:-}" evaluator

# --- application settings: nothing configured by hand in the admin UI --------
# App name/URL (shown in verification + reset emails), PB's OWN SMTP (signup
# verification + password resets — separate from the evaluator's alert SMTP),
# S3 backups to Cloudflare R2, and the request-log level. meta and logs are
# always set; SMTP and backups are applied only when their env is present, so a
# partial config never clobbers.
#
# logs.minLevel MUST be set at provisioning, not afterwards (#331). At the
# default 0 (info) PocketBase writes a row per API request: on dev that grew
# auxiliary.db to ~953 MB against ~45 MB of real data — 21x — which would eat
# the data volume and make its sizing meaningless. 4 = warn.
echo "==> applying settings (app name/URL, request-log level, SMTP, R2 backups) via /api/settings"
settings_body="$(jq -nc \
  --arg logsMinLevel   "${PB_LOGS_MIN_LEVEL:-4}" \
  --arg appName        "${PB_APP_NAME:-nabz}" \
  --arg appURL         "${PB_APP_URL:-}" \
  --arg senderName     "${PB_SENDER_NAME:-nabz}" \
  --arg senderAddress  "${PB_SENDER_ADDRESS:-}" \
  --arg smtpHost       "${PB_SMTP_HOST:-}" \
  --arg smtpPort       "${PB_SMTP_PORT:-587}" \
  --arg smtpUser       "${PB_SMTP_USERNAME:-}" \
  --arg smtpPass       "${PB_SMTP_PASSWORD:-}" \
  --arg smtpTLS        "${PB_SMTP_TLS:-false}" \
  --arg s3Endpoint     "${PB_BACKUP_S3_ENDPOINT:-}" \
  --arg s3Bucket       "${PB_BACKUP_S3_BUCKET:-}" \
  --arg s3Region       "${PB_BACKUP_S3_REGION:-auto}" \
  --arg s3Key          "${PB_BACKUP_S3_ACCESS_KEY:-}" \
  --arg s3Secret       "${PB_BACKUP_S3_SECRET:-}" \
  --arg backupCron     "${PB_BACKUP_CRON:-}" \
  --arg backupKeep     "${PB_BACKUP_MAX_KEEP:-0}" '
  { meta: ({ appName: $appName, senderName: $senderName }
      + (if $appURL == "" then {} else { appURL: $appURL } end)
      + (if $senderAddress == "" then {} else { senderAddress: $senderAddress } end)),
    logs: { minLevel: ($logsMinLevel | tonumber) } }
  + (if $smtpHost == "" then {} else
      { smtp: { enabled: true, host: $smtpHost, port: ($smtpPort | tonumber),
                username: $smtpUser, password: $smtpPass, authMethod: "PLAIN",
                tls: ($smtpTLS == "true") } } end)
  # PB own cron defaults to OFF (#322): the maintenance timer drives backups so
  # they run AFTER the checkpoint and vacuum, and so cronMaxKeep does not become a
  # second retention policy pruning the same bucket R2 lifecycle already expires.
  + (if ($s3Endpoint == "" or $s3Bucket == "") then {} else
      { backups: { cron: $backupCron, cronMaxKeep: ($backupKeep | tonumber),
                   s3: { enabled: true, bucket: $s3Bucket, region: $s3Region,
                         endpoint: $s3Endpoint, accessKey: $s3Key, secret: $s3Secret,
                         forcePathStyle: true } } } end)')"
code="$(curl -sS -o /tmp/pb_settings.json -w '%{http_code}' \
  "http://${PB_ADDR}:${PB_PORT}/api/settings" -X PATCH \
  -H "Authorization: $TOKEN" -H 'Content-Type: application/json' --data-binary "$settings_body")"
case "$code" in
  200) echo "   settings applied (app name/URL, logs.minLevel=${PB_LOGS_MIN_LEVEL:-4}$([ -n "${PB_SMTP_HOST:-}" ] && echo ', SMTP')$([ -n "${PB_BACKUP_S3_ENDPOINT:-}" ] && echo ', R2 backups'))";;
  *)   echo "   WARN: /api/settings PATCH got HTTP $code: $(cat /tmp/pb_settings.json)";;
esac

# --- seed the zones collection (#311) ----------------------------------------
# Labels and ordering for zone codes. Seeded here rather than in the schema
# import because the import is additive over collections, not rows.
#
# ONLY eu-central. us-east is deliberately NOT seeded: the ash worker was dropped
# from FLEET (cx23 is EU-only), so a us-east row would put a zone in the monitor
# picker that no worker will ever report for — the exact dead-zone failure #328
# fixed. A zone row goes in when a worker for it does.
#
# `code` is the queue key and is stamped into every checks row, so it is created
# once and never edited here; display_name is the part that is safe to change.
echo "==> seeding zones"
seed_zone() { # code group_code group_name display_name sort_order
  existing="$(curl -fsS "http://${PB_ADDR}:${PB_PORT}/api/collections/zones/records?perPage=1&skipTotal=true&filter=$(jq -rn --arg c "$1" '@uri "code=\"\($c)\""')" \
    -H "Authorization: $TOKEN" 2>/dev/null | jq -r '.items[0].id // empty')"
  if [ -n "$existing" ]; then
    echo "   $1 already present"
    return
  fi
  body="$(jq -nc --arg c "$1" --arg gc "$2" --arg gn "$3" --arg dn "$4" --argjson so "$5" \
    '{code:$c, group_code:$gc, group_name:$gn, display_name:$dn, enabled:true, sort_order:$so}')"
  code="$(curl -sS -o /tmp/pb_zone.json -w '%{http_code}' \
    "http://${PB_ADDR}:${PB_PORT}/api/collections/zones/records" -X POST \
    -H "Authorization: $TOKEN" -H 'Content-Type: application/json' -d "$body")"
  case "$code" in
    200) echo "   seeded $1 ($4)";;
    *)   echo "   WARN: seeding zone $1 got HTTP $code: $(cat /tmp/pb_zone.json)";;
  esac
}
seed_zone eu-central eu Europe "EU" 10

# users.listRule so the web service account can count users for /admin/usage
# (#246). The built-in users collection isn't in pb_schema.json, so the schema
# import can't set this — do it here. Merges just this one field.
echo "==> setting users.listRule for /admin/usage (#246)"
code="$(curl -sS -o /tmp/pb_users.json -w '%{http_code}' \
  "http://${PB_ADDR}:${PB_PORT}/api/collections/users" -X PATCH \
  -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg r 'id = @request.auth.id || @request.auth.collectionName = "service_accounts"' '{listRule:$r}')")"
case "$code" in
  200) echo "   users.listRule set";;
  *)   echo "   WARN: users listRule PATCH got HTTP $code: $(cat /tmp/pb_users.json)";;
esac

# --- default app users (#392) -------------------------------------------------
# Two ordinary users in the built-in `users` collection, so a fresh environment is
# signed-into-able without hand-creating records. Neither is a PocketBase
# superuser and neither is a service_accounts row — those are separate mechanisms
# for machines. "Admin" here means only that the address is in ADMIN_EMAILS, which
# is what gates /admin/usage; seeding a user grants nothing on its own.
#
# Both are seeded with must_change_password=true, so the shared default password
# cannot survive first sign-in.

# The flag field. `users` is PocketBase's built-in auth collection and is NOT in
# pb_schema.json, so the schema import cannot add it — same reason users.listRule
# is patched above rather than declared. PATCH replaces the whole fields array, so
# read the current one and append; skipped entirely when it already exists, which
# is what makes a re-run a no-op.
echo "==> ensuring users.must_change_password exists"
users_fields="$(curl -fsS "http://${PB_ADDR}:${PB_PORT}/api/collections/users" \
  -H "Authorization: $TOKEN" | jq -c '.fields')"
if jq -e 'any(.[]; .name == "must_change_password")' >/dev/null 2>&1 <<<"$users_fields"; then
  echo "   already present"
else
  new_fields="$(jq -c '. + [{name:"must_change_password", type:"bool", required:false,
                             presentable:false, system:false, hidden:false}]' <<<"$users_fields")"
  code="$(curl -sS -o /tmp/pb_mcp.json -w '%{http_code}' \
    "http://${PB_ADDR}:${PB_PORT}/api/collections/users" -X PATCH \
    -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
    -d "$(jq -nc --argjson f "$new_fields" '{fields:$f}')")"
  case "$code" in
    200) echo "   added must_change_password";;
    *)   echo "   WARN: adding must_change_password got HTTP $code: $(cat /tmp/pb_mcp.json)";;
  esac
fi
# The default users.updateRule is `id = @request.auth.id`, which already lets a
# user write this field on their own record — verified against PocketBase 0.28.4,
# so the app can clear the flag with the user's own token and no rule change is
# needed here. If that rule is ever tightened, clearing the flag breaks and this
# is where to fix it.

seed_app_user() { # email password label
  local email="$1" pass="$2" label="$3" existing code
  [ -n "$email" ] && [ -n "$pass" ] || { echo "   skip $label (no email/password)"; return 0; }
  existing="$(curl -fsS "http://${PB_ADDR}:${PB_PORT}/api/collections/users/records?perPage=1&skipTotal=true&filter=$(jq -rn --arg e "$email" '@uri "email=\"\($e)\""')" \
    -H "Authorization: $TOKEN" 2>/dev/null | jq -r '.items[0].id // empty')"
  if [ -n "$existing" ]; then
    # Untouched on purpose: re-running must not reset a password or re-raise the
    # flag on an account that has already rotated away from the seeded one.
    echo "   $label already exists ($email) — left untouched"
    return 0
  fi
  code="$(curl -sS -o /tmp/pb_user.json -w '%{http_code}' \
    "http://${PB_ADDR}:${PB_PORT}/api/collections/users/records" -X POST \
    -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg e "$email" --arg p "$pass" \
        '{email:$e, password:$p, passwordConfirm:$p, verified:true,
          emailVisibility:false, must_change_password:true}')")"
  case "$code" in
    200|201) echo "   created $label ($email) — must change password on first sign-in";;
    400)     echo "   $label already exists ($email)";;
    *)       echo "   WARN: seeding $label got HTTP $code: $(cat /tmp/pb_user.json)";;
  esac
}

echo "==> seeding default app users"
seed_app_user "${SEED_ADMIN_EMAIL:-admin@nabz.sh}" "${SEED_PASSWORD:-demo1234}" "admin user"
seed_app_user "${SEED_USER_EMAIL:-user@nabz.sh}"   "${SEED_PASSWORD:-demo1234}" "regular user"

# --- maintenance timer (#322) -------------------------------------------------
# systemd rather than cron: it gives a persistent timer that catches up after the
# host was off, a journal to read afterwards, and a failure state an operator can
# query — none of which a crontab line has.
echo "==> installing the maintenance timer"
install -m 755 "$APP_DIR/deploy/pocketbase/maintenance.sh" /usr/local/bin/nabz-pb-maintenance
cat > /etc/systemd/system/nabz-pb-maintenance.service <<UNIT
[Unit]
Description=nabz PocketBase maintenance (checkpoint, bounded vacuum, backup)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
EnvironmentFile=-${ENV_FILE}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/local/bin/nabz-pb-maintenance
UNIT
cat > /etc/systemd/system/nabz-pb-maintenance.timer <<UNIT
[Unit]
Description=Run nabz PocketBase maintenance daily

[Timer]
OnCalendar=${PB_MAINTENANCE_ONCALENDAR:-*-*-* 03:17:00}
# Catch up after downtime: a host that was off overnight should still take a
# backup when it comes back, not silently skip a day.
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now nabz-pb-maintenance.timer >/dev/null 2>&1 \
  && echo "   nabz-pb-maintenance.timer enabled ($(systemctl show -p NextElapseUSecRealtime --value nabz-pb-maintenance.timer 2>/dev/null || echo scheduled))" \
  || echo "   WARN: could not enable nabz-pb-maintenance.timer"

echo; echo "PocketBase ready on :${PB_PORT}.  Admin UI: http://<this-host-ip>:${PB_PORT}/_/"
