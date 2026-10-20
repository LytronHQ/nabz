#!/usr/bin/env bash
#
# Bootstrap a bare Ubuntu/Debian host as a monitors WORKER node (one per zone),
# then hand off to docker compose. This script ONLY bootstraps (Docker, code,
# env file) — what actually runs is defined in deploy/worker.yml, the single
# source of truth.
#
#   curl -fsSL https://raw.githubusercontent.com/LytronHQ/nabz/main/deploy/setup-worker.sh | sudo bash
#   # first run creates the env file and stops; fill it in, then run again
#
# Overridable via env: REPO_URL, APP_DIR, ENV_FILE, REGION_NAME
set -euo pipefail

# SSH forwards the client's LC_*/LANG; a minimal image often lacks those locales,
# which makes perl/dpkg spew "Setting locale failed" during apt. Pin a locale that
# always exists so provisioning output stays clean.
export LC_ALL=C.UTF-8 LANG=C.UTF-8

REPO_URL="${REPO_URL:-https://github.com/LytronHQ/nabz.git}"
APP_DIR="${APP_DIR:-/opt/monitors}"
ENV_FILE="${ENV_FILE:-/etc/monitors/worker.env}"

[ "$(id -u)" = "0" ] || { echo "Please run as root (or with sudo)."; exit 1; }

echo "==> curl + git + Docker"
command -v curl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y curl ca-certificates; }
command -v git >/dev/null 2>&1 || { apt-get update -y && apt-get install -y git; }
command -v docker >/dev/null 2>&1 || { curl -fsSL https://get.docker.com | sh; systemctl enable --now docker; }
# Let the login user run docker without sudo (takes effect on their next login).
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ] && getent group docker >/dev/null 2>&1; then
  usermod -aG docker "$SUDO_USER"
fi

if [ "${SKIP_CLONE:-0}" = "1" ]; then
  # Code was pushed from the laptop (remote-deploy.sh) — don't touch git.
  [ -d "$APP_DIR" ] || { echo "SKIP_CLONE=1 but $APP_DIR is missing"; exit 1; }
  echo "==> Using code at $APP_DIR (pushed from laptop)"
else
  echo "==> Code -> $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone --depth 1 "$REPO_URL" "$APP_DIR"; fi
fi

if [ ! -f "$ENV_FILE" ]; then
  mkdir -p "$(dirname "$ENV_FILE")"
  cp "$APP_DIR/deploy/worker.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo; echo ">> Created $ENV_FILE — fill it in (PB creds, PB_AUTH_COLLECTION, REGION_NAME), then re-run."
  exit 1
fi
[ -n "${REGION_NAME:-}" ] && sed -i "s/^REGION_NAME=.*/REGION_NAME=${REGION_NAME}/" "$ENV_FILE"

# One-time host hardening (ufw / auto-updates / fail2ban / key-only SSH).
if [ ! -f /etc/monitors/.hardened ]; then
  bash "$APP_DIR/deploy/.ops/server.sh" harden && touch /etc/monitors/.hardened
fi

# The private NIC has to be up before anything tries to reach PocketBase over it
# (#338). Cloud-side attachment does not guarantee guest-side configuration — see
# the script for what goes wrong when it is missing.
if [ -x "$APP_DIR/deploy/ensure-private-net.sh" ]; then
  # From the env file, not the environment: these scripts read $ENV_FILE rather
  # than sourcing it. `|| true` because a missing key is normal (dev has no
  # private network) and `set -o pipefail` would otherwise abort on grep's exit 1.
  PRIV_SUBNET="$(grep -E '^PRIVATE_SUBNET=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  PRIVATE_SUBNET="$PRIV_SUBNET" bash "$APP_DIR/deploy/ensure-private-net.sh"
fi

echo "==> docker compose up"
cd "$APP_DIR"

# Workers on this node. A zone may hold any number of them, here and on other
# hosts: each one heartbeats into worker_heartbeats, reads the zone's roster and
# checks only its own shard of the monitors, so adding one adds capacity instead
# of duplicating probes.
#
REPLICAS="$(grep -E '^WORKER_REPLICAS=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
REPLICAS="${REPLICAS:-1}"
case "$REPLICAS" in ''|*[!0-9]*) REPLICAS=1 ;; esac
[ "$REPLICAS" -ge 1 ] || REPLICAS=1
[ "$REPLICAS" -le 4 ] || { echo "error: WORKER_REPLICAS=$REPLICAS, but deploy/worker.yml declares 4." >&2
                           echo "  Add a worker-5 service there, or spread the load over more nodes." >&2; exit 1; }

# A stable WORKER_ID is what makes a redeploy invisible to the rest of the zone:
# the restarted worker updates the row it already had, the row goes stale for the
# seconds the container is down, and the TTL covers it. Without one, each replica
# falls back to its container id — new on every recreate — and the zone sees the
# dead ids alongside the live ones until the old rows age out, with the monitors
# hashing to a dead index checked by nobody in the meantime.
FIXED_ID="$(grep -E '^WORKER_ID=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
if [ "$REPLICAS" -gt 1 ] && [ -z "$FIXED_ID" ]; then
  echo "error: WORKER_REPLICAS=$REPLICAS with no WORKER_ID in $ENV_FILE." >&2
  echo "  Every replica would take its container id as its worker id, and those" >&2
  echo "  change on each deploy — the zone would spend a roster TTL believing the" >&2
  echo "  dead workers are still there, leaving part of itself unchecked." >&2
  echo "  remote-deploy.sh sets WORKER_ID; set it yourself if deploying by hand." >&2
  exit 1
fi

# One profile per extra replica; the base `worker` service is always on.
PROFILES=()
i=2
while [ "$i" -le "$REPLICAS" ]; do PROFILES+=(--profile "replica$i"); i=$((i + 1)); done

# NO_START=1 (replace-worker, #418): build and create, do not start. The old host
# in this zone is still checking; starting here too would put two workers in the
# zone, each owning half of it, until replace-worker has drained the old one.
if [ "${NO_START:-0}" = "1" ]; then
  docker compose --env-file "$ENV_FILE" -f deploy/worker.yml "${PROFILES[@]}" \
    up --no-start --build --remove-orphans
  echo "   worker replicas: $REPLICAS — created, NOT started (NO_START=1)"
  exit 0
fi
docker compose --env-file "$ENV_FILE" -f deploy/worker.yml "${PROFILES[@]}" \
  up -d --build --remove-orphans
echo "   worker replicas: $REPLICAS"

echo; echo "Up. Logs:  docker compose -f $APP_DIR/deploy/worker.yml logs -f"
