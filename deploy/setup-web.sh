#!/usr/bin/env bash
#
# Bootstrap a bare Ubuntu/Debian host as a monitors WEB node (the SvelteKit app),
# then hand off to docker compose. This script ONLY bootstraps; what runs is
# defined in deploy/web.yml, the single source of truth.
#
#   curl -fsSL .../deploy/setup-web.sh | sudo bash   # first run creates env, stops
#
# Overridable via env: REPO_URL, APP_DIR, ENV_FILE
set -euo pipefail

# SSH forwards the client's LC_*/LANG; pin one that always exists so apt stays quiet.
export LC_ALL=C.UTF-8 LANG=C.UTF-8

REPO_URL="${REPO_URL:-https://github.com/LytronHQ/nabz.git}"
APP_DIR="${APP_DIR:-/opt/monitors}"
ENV_FILE="${ENV_FILE:-/etc/monitors/web.env}"

[ "$(id -u)" = "0" ] || { echo "Please run as root (or with sudo)."; exit 1; }

echo "==> curl + git + Docker"
command -v curl   >/dev/null 2>&1 || { apt-get update -y && apt-get install -y curl ca-certificates; }
command -v git    >/dev/null 2>&1 || { apt-get update -y && apt-get install -y git; }
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
  cp "$APP_DIR/deploy/web.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo; echo ">> Created $ENV_FILE — fill it in (PB_URL, ORIGIN, PKCE key), then re-run."
  exit 1
fi

if [ ! -f /etc/monitors/.hardened ]; then
  bash "$APP_DIR/deploy/harden.sh" && touch /etc/monitors/.hardened
fi

echo "==> docker compose up (builds the SvelteKit app — first run takes a few minutes)"
cd "$APP_DIR"
docker compose --env-file "$ENV_FILE" -f deploy/web.yml up -d --build

echo; echo "Up. App on :3000. Logs:  docker compose -f $APP_DIR/deploy/web.yml logs -f"
