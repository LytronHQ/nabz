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
  bash "$APP_DIR/deploy/harden.sh" && touch /etc/monitors/.hardened
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

# The Valkey sidecar now lives behind a profile so a multi-VM zone can turn it off
# (#311). Start it only when this node is NOT pointed at a shared Valkey —
# otherwise the node would run a second, private due-set for the zone, which means
# two seed leaders and every monitor probed twice.
CACHE_HOST_EFFECTIVE="$(grep -E '^CACHE_HOST=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
PROFILE=()
case "${CACHE_HOST_EFFECTIVE:-valkey}" in
  valkey|"") PROFILE=(--profile local-cache); echo "   local Valkey sidecar: on" ;;
  *) echo "   shared Valkey at ${CACHE_HOST_EFFECTIVE}: sidecar off" ;;
esac

# Replicas of the worker on this node. They share the node's Valkey and elect one
# seeder between them, so this needs no other configuration.
# Absent on any node whose env file predates this setting, which is the common
# case — `|| true` because "not set" means "one replica", not "fail the deploy".
REPLICAS="$(grep -E '^WORKER_REPLICAS=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
REPLICAS="${REPLICAS:-1}"
docker compose --env-file "$ENV_FILE" -f deploy/worker.yml "${PROFILE[@]}" \
  up -d --build --scale "worker=${REPLICAS}"
echo "   worker replicas: $REPLICAS"

echo; echo "Up. Logs:  docker compose -f $APP_DIR/deploy/worker.yml logs -f"
