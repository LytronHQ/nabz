#!/usr/bin/env bash
#
# Deploy monitors nodes to a set of remote hosts, from your laptop, over SSH.
# One command per environment; all settings (SSH key, host IPs, PB creds) come
# from Bitwarden Secrets Manager (prod/staging) or deploy/<env>.env (dev).
#
#   ./deploy/remote-deploy.sh dev     # reads deploy/dev.env   (local VMs)
#   ./deploy/remote-deploy.sh production   # secrets from Bitwarden (Hetzner)
#
# For each host it: pushes /etc/monitors/<role>.env, then runs the on-host
# setup script over SSH (which installs Docker, clones the repo, and
# `docker compose up -d`). Re-run any time to update.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
APP_DIR="${APP_DIR:-/opt/monitors}"
ENV_NAME="${1:-}"
[ -n "$ENV_NAME" ] || { echo "usage: $0 <env>    (reads deploy/<env>.env)"; exit 1; }
# Secret values come from Bitwarden Secrets Manager; the repo holds no plaintext.
# A local deploy/<env>.env still wins when present — that is the libvirt dev flow,
# which has no BWS project.
ENV_FILE="$HERE/${ENV_NAME}.env"
if [ ! -f "$ENV_FILE" ]; then
  [ -f "$HERE/environments/${ENV_NAME}.vars" ] || {
    echo "No $ENV_FILE and no deploy/environments/${ENV_NAME}.vars — nothing to deploy from."; exit 1; }
  echo "==> materializing '$ENV_NAME' from Bitwarden Secrets Manager"
  ENV_FILE="$("$HERE/bws-env.sh" "$ENV_NAME")"
fi

# Provisioning outputs describe infrastructure that exists right now: which hosts,
# which IPs, which data device. infra-hetzner reads them from the Hetzner API and
# passes them in, so they must beat any stored copy — a rebuilt server changes its
# IP, and a deploy that trusts a stale one SSHes confidently into the wrong place.
PROVISIONED="NODES PB_URL PB_BIND_IP PB_DATA_DEVICE PRIVATE_SUBNET"
for k in $PROVISIONED; do eval "_ovr_$k=\${$k:-}"; done

set -a; . "$ENV_FILE"; set +a

for k in $PROVISIONED; do
  eval "_v=\$_ovr_$k"
  [ -n "${_v:-}" ] && eval "export $k=\$_ovr_$k"
done
unset _v

# Bitwarden stores the key itself (SSH_PRIVATE_KEY); ssh needs a file. Write it
# to a private temp file for the life of this run rather than asking the operator
# to keep a path and a key in sync.
# On a laptop the key is simply a file in ~/.ssh, named by SSH_KEY_FILE in the
# environment's vars. It is never copied into Bitwarden, so this is how a local
# deploy finds it; CI passes SSH_PRIVATE_KEY instead.
if [ -z "${SSH_KEY:-}" ] && [ -z "${SSH_PRIVATE_KEY:-}" ] && [ -n "${SSH_KEY_FILE:-}" ]; then
  [ -r "$HOME/.ssh/$SSH_KEY_FILE" ] \
    && SSH_KEY="$HOME/.ssh/$SSH_KEY_FILE" \
    || die_msg="no readable ~/.ssh/$SSH_KEY_FILE"
fi

if [ -z "${SSH_KEY:-}" ] && [ -n "${SSH_PRIVATE_KEY:-}" ]; then
  SSH_KEY="$(mktemp)"; chmod 600 "$SSH_KEY"
  printf '%s\n' "$SSH_PRIVATE_KEY" > "$SSH_KEY"
  trap 'rm -f "$SSH_KEY"' EXIT
fi

# The ping URL is not configuration: Better Stack owns it, and the API token that
# created the heartbeat can read it back. Storing a copy only creates something
# that can go stale or be forgotten — the evaluator then runs with its dead-man's
# switch silently off, which is the exact failure the switch exists to catch.
# An explicit HEALTHCHECK_PING_URL still wins, and lookup failure is never fatal.
# Same read-it-back-from-the-owner approach for the maintenance heartbeat (#322):
# Better Stack owns the URL, and storing a copy only creates something that can go
# stale while the backup quietly stops being watched.
if [ -z "${PB_MAINTENANCE_PING_URL:-}" ] && [ -n "${BETTERSTACK_API_TOKEN:-}" ]; then
  PB_MAINTENANCE_PING_URL="$(curl -sS --max-time 10 "https://uptime.betterstack.com/api/v2/heartbeats" \
    -H "Authorization: Bearer $BETTERSTACK_API_TOKEN" 2>/dev/null \
    | jq -r --arg n "nabz-pb-maintenance ($ENV_NAME)" \
        '.data[]? | select(.attributes.name == $n) | .attributes.url // empty' | head -1)" || true
  [ -n "${PB_MAINTENANCE_PING_URL:-}" ] \
    && echo "==> maintenance heartbeat: resolved from Better Stack" \
    || echo "WARNING: no Better Stack heartbeat named 'nabz-pb-maintenance ($ENV_NAME)'; run infra-watch." >&2
fi

if [ -z "${HEALTHCHECK_PING_URL:-}" ] && [ -n "${BETTERSTACK_API_TOKEN:-}" ]; then
  HEALTHCHECK_PING_URL="$(curl -sS --max-time 10 "https://uptime.betterstack.com/api/v2/heartbeats" \
    -H "Authorization: Bearer $BETTERSTACK_API_TOKEN" 2>/dev/null \
    | jq -r --arg n "nabz-evaluator ($ENV_NAME)" \
        '.data[]? | select(.attributes.name == $n) | .attributes.url // empty' | head -1)" || true
  if [ -n "${HEALTHCHECK_PING_URL:-}" ]; then
    echo "==> dead-man's switch: resolved from Better Stack"
  else
    echo "WARNING: no Better Stack heartbeat named 'nabz-evaluator ($ENV_NAME)'." >&2
    echo "         Run infra-watch for this environment; until then the evaluator" >&2
    echo "         runs with its dead-man's switch off." >&2
  fi
fi

[ -n "${SSH_KEY:-}" ] || {
  echo "error: no deploy key for '$ENV_NAME'${die_msg:+ — $die_msg}." >&2
  echo "  Set SSH_KEY_FILE in deploy/environments/${ENV_NAME}.vars to a key in ~/.ssh," >&2
  echo "  or pass SSH_PRIVATE_KEY (which is what CI does)." >&2
  exit 1; }
: "${PB_URL:?set PB_URL in $ENV_FILE}"
: "${NODES:?set NODES in $ENV_FILE}"
SSH_USER="${SSH_USER:-root}"
PB_AUTH_COLLECTION="${PB_AUTH_COLLECTION:-service_accounts}"
SSH_KEY="${SSH_KEY/#\~/$HOME}"
SUDO=""; [ "$SSH_USER" != "root" ] && SUDO="sudo"

# Build stamp for the health debug tier (#103): the version + commit this deploy
# ships. Computed here on the deploying machine (the nodes get no .git). A deploy
# carries the working tree (tracked files), so flag uncommitted changes as -dirty.
BUILD_VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION" 2>/dev/null || echo dev)"
BUILD_COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
git -C "$REPO_ROOT" diff --quiet 2>/dev/null || BUILD_COMMIT="${BUILD_COMMIT}-dirty"

# SetEnv=LC_ALL=C.UTF-8 overrides the client locale SSH would otherwise forward
# (e.g. en_GB.UTF-8), which a minimal node lacks -> stops perl/dpkg locale spam.
#
# IdentitiesOnly=yes is what makes -i mean "this key and no other". Without it -i
# only ADDS a key: ssh still offers every key in the agent first, and sshd closes
# the connection after MaxAuthTries (6 by default). On a laptop with a populated
# agent that produced
#
#   Received disconnect from …: Too many authentication failures
#
# on the first node — a message naming neither the key nor the problem, while the
# real error (Permission denied for the configured key) never appeared. It is not
# only a bad message: with a CORRECT key, six agent keys offered ahead of it fail
# the deploy just the same, and the order the agent hands them over is not
# something this script controls. CI never sees it, because a runner's agent is
# empty; the laptop that deploys production is exactly where it bites.
sshc() { ssh -i "$SSH_KEY" -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
  -o SetEnv=LC_ALL=C.UTF-8 "${SSH_USER}@$1" "$2"; }

push_env() { # host role content
  # An empty body is never legitimate, and it is reachable: the callers pass
  # "$(role_env …)", and a ${VAR:?} inside a command substitution in ARGUMENT
  # position has its exit status discarded — `set -e` does not fire. So a missing
  # WORKER_PB_PASSWORD produced a zero-byte /etc/monitors/worker.env, setup's
  # `[ ! -f "$ENV_FILE" ]` guard passed because the file existed, and the node was
  # deployed with no configuration at all. Verified by repro: push_env received 0
  # bytes and the script continued.
  [ -n "$3" ] || {
    echo "refusing to write an EMPTY /etc/monitors/$2.env to $1." >&2
    echo "  A required value was unset while composing it — the line above naming" >&2
    echo "  a variable as null or not set is the one to fix." >&2
    exit 1
  }
  sshc "$1" "$SUDO mkdir -p /etc/monitors && $SUDO tee /etc/monitors/$2.env >/dev/null && $SUDO chmod 600 /etc/monitors/$2.env" <<<"$3"
}
push_code() { # host — ship the local working tree (tracked files only: respects
  # .gitignore, so no secrets/node_modules/.git) PLUS deploy/.ops.
  #
  # deploy/.ops holds the ops scripts, fetched from the release pinned in
  # deploy/ops.lock rather than committed. They are gitignored, so ls-files does
  # not list them, and they are exactly what the node needs: server.sh hardens it,
  # db.sh becomes its maintenance timer, container.sh upgrades it. Shipping them
  # here is what keeps "no GitHub access needed on nodes" true — a provisioning run
  # must not depend on a download at the step that rewrites the firewall and SSH.
  command -v git >/dev/null 2>&1 || { echo "git required on this laptop"; exit 1; }
  "$HERE/ops-fetch.sh" --check >/dev/null 2>&1 || "$HERE/ops-fetch.sh"
  # Both lists are NUL-separated to match tar's --null, and both are relative to
  # REPO_ROOT so they land at the same paths on the node.
  { git -C "$REPO_ROOT" ls-files -z
    ( cd "$REPO_ROOT" && find deploy/.ops -print0 )
  } | tar -C "$REPO_ROOT" --null -T - -cf - \
    | sshc "$1" "$SUDO rm -rf $APP_DIR && $SUDO mkdir -p $APP_DIR && $SUDO tar xf - -C $APP_DIR"
}
run_setup() { # host role — SKIP_CLONE: use the code we just pushed, don't git clone
  # NO_START (replace-worker, #418) reaches a worker's setup only: it builds and
  # creates the containers but leaves them stopped, so the new host is ready the
  # moment the old one has drained. Unset, the command is exactly what it was.
  local no_start=""
  if [ "$2" = worker ] && [ "${NO_START:-}" = 1 ]; then no_start=" NO_START=1"; fi
  sshc "$1" "$SUDO SKIP_CLONE=1${no_start} bash -s" <"$HERE/setup-$2.sh"
}

# pocketbase.env is SOURCED BY BASH on the host (setup-pocketbase.sh does
# `set -a; . "$ENV_FILE"`), unlike the worker/evaluator/web files which go to
# `docker compose --env-file` and are parsed literally. So every value here has
# to be shell-quoted: PB_BACKUP_CRON's default "0 3 * * *" otherwise assigns
# PB_BACKUP_CRON=0 and then tries to RUN `3`, aborting the whole setup under
# `set -e` before PocketBase is ever started.
kv() { printf "%s='%s'\n" "$1" "$(printf '%s' "${2:-}" | sed "s/'/'\\\\''/g")"; }

pocketbase_env() {
  # Service accounts are seeded from the same WORKER_PB_*/EVALUATOR_PB_* creds
  # the worker/evaluator nodes authenticate with, so they stay in sync. App
  # name/URL, PB's own SMTP, and R2 backups are applied via /api/settings — no
  # admin-UI clicks. All optional except the superuser + version.
  kv PB_SUPERUSER_EMAIL    "${PB_SUPERUSER_EMAIL:?set PB_SUPERUSER_EMAIL in $ENV_FILE}"
  kv PB_SUPERUSER_PASSWORD "${PB_SUPERUSER_PASSWORD:?set PB_SUPERUSER_PASSWORD in $ENV_FILE}"
  kv PB_VERSION            "${PB_VERSION:-0.40.5}"
  kv PB_SHA256             "${PB_SHA256:-}"
  kv PB_DATA_DEVICE        "${PB_DATA_DEVICE:-}"
  kv PB_DATA_MOUNT         "${PB_DATA_MOUNT:-/mnt/pb-data}"
  kv PB_BIND_IP            "${PB_BIND_IP:-}"
  kv PRIVATE_SUBNET        "${PRIVATE_SUBNET:-}"
  kv TUNNEL_TOKEN          "${TUNNEL_TOKEN:-}"
  kv CLOUDFLARED_VERSION   "${CLOUDFLARED_VERSION:-2026.8.2}"
  kv PB_LOGS_MIN_LEVEL     "${PB_LOGS_MIN_LEVEL:-4}"
  kv SEED_WORKER_USERNAME     "${WORKER_PB_USERNAME:-}"
  kv SEED_WORKER_PASSWORD     "${WORKER_PB_PASSWORD:-}"
  kv SEED_EVALUATOR_USERNAME  "${EVALUATOR_PB_USERNAME:-}"
  kv SEED_EVALUATOR_PASSWORD  "${EVALUATOR_PB_PASSWORD:-}"
  # Default APP users (#392) — ordinary users, not service accounts. Seeded with a
  # shared password and must_change_password=true, so it cannot survive first
  # sign-in. Existing records are never touched by a re-run.
  kv SEED_ADMIN_EMAIL      "${SEED_ADMIN_EMAIL:-admin@nabz.sh}"
  kv SEED_USER_EMAIL       "${SEED_USER_EMAIL:-user@nabz.sh}"
  kv SEED_PASSWORD         "${SEED_PASSWORD:-demo1234}"
  # Sign in with GitHub / Google (#609), from Bitwarden. Optional: a provider
  # without both halves stays off (deploy/pb-oauth.sh).
  kv OAUTH_GITHUB_CLIENT_ID     "${OAUTH_GITHUB_CLIENT_ID:-}"
  kv OAUTH_GITHUB_CLIENT_SECRET "${OAUTH_GITHUB_CLIENT_SECRET:-}"
  kv OAUTH_GOOGLE_CLIENT_ID     "${OAUTH_GOOGLE_CLIENT_ID:-}"
  kv OAUTH_GOOGLE_CLIENT_SECRET "${OAUTH_GOOGLE_CLIENT_SECRET:-}"
  kv PB_APP_NAME           "${PB_APP_NAME:-nabz}"
  # PocketBase's own mail (verification, password reset, email change) goes
  # through the same MailerSend account as the alerts unless PB_SMTP_* say
  # otherwise. Unset, PocketBase fell back to a sendmail the container does not
  # have, so production never sent an account email (#627). Its links are built
  # from appURL, which is the web; the sender is no-reply@ on the alerts' domain,
  # which MailerSend has verified.
  kv PB_APP_URL            "${PB_APP_URL:-${WEB_URL:-}}"
  kv PB_SENDER_NAME        "${PB_SENDER_NAME:-nabz}"
  kv PB_SENDER_ADDRESS     "${PB_SENDER_ADDRESS:-${SMTP_FROM:+no-reply@${SMTP_FROM##*@}}}"
  kv PB_SMTP_HOST          "${PB_SMTP_HOST:-${SMTP_HOST:-}}"
  kv PB_SMTP_PORT          "${PB_SMTP_PORT:-${SMTP_PORT:-587}}"
  kv PB_SMTP_USERNAME      "${PB_SMTP_USERNAME:-${SMTP_USERNAME:-}}"
  kv PB_SMTP_PASSWORD      "${PB_SMTP_PASSWORD:-${SMTP_PASSWORD:-}}"
  kv PB_SMTP_TLS           "${PB_SMTP_TLS:-false}"
  kv PB_BACKUP_S3_ENDPOINT "${PB_BACKUP_S3_ENDPOINT:-}"
  kv PB_BACKUP_S3_BUCKET   "${PB_BACKUP_S3_BUCKET:-}"
  kv PB_BACKUP_S3_REGION   "${PB_BACKUP_S3_REGION:-auto}"
  kv PB_BACKUP_S3_ACCESS_KEY "${PB_BACKUP_S3_ACCESS_KEY:-}"
  kv PB_BACKUP_S3_SECRET   "${PB_BACKUP_S3_SECRET:-}"
  # Both default to OFF (#322). The maintenance timer drives backups so they land
  # after the checkpoint and vacuum, and so PocketBase's own cronMaxKeep does not
  # prune the bucket R2 lifecycle expiry already prunes.
  kv PB_BACKUP_CRON        "${PB_BACKUP_CRON:-}"
  kv PB_BACKUP_MAX_KEEP    "${PB_BACKUP_MAX_KEEP:-0}"
  # Maintenance run (#322): how many free pages one bounded vacuum may reclaim,
  # when the timer fires, and an optional heartbeat pinged only on success so the
  # external monitor alerts on silence.
  kv PB_VACUUM_PAGES       "${PB_VACUUM_PAGES:-20000}"
  kv PB_MAINTENANCE_ONCALENDAR "${PB_MAINTENANCE_ONCALENDAR:-*-*-* 03:17:00}"
  kv PB_MAINTENANCE_PING_URL   "${PB_MAINTENANCE_PING_URL:-}"
}
web_env() { # ip
  # The public /ping/{token} heartbeat endpoint records a check-in with a service
  # account: it updates the monitor (any service_account may) AND writes a `checks`
  # row for history (create rule = role "worker"). Default it to the worker creds
  # unless a dedicated account is provided via WEB_PB_USERNAME/WEB_PB_PASSWORD.
  cat <<EOF
PB_URL=${PB_URL}
PKCE_FLOW_ENCRYPTION_KEY=${PKCE_FLOW_ENCRYPTION_KEY:-dev-only-not-a-secret}
ORIGIN=http://${1}:3000
NODE_ENV=${WEB_NODE_ENV:-}
WEB_PB_COLLECTION=${PB_AUTH_COLLECTION:-service_accounts}
WEB_PB_USERNAME=${WEB_PB_USERNAME:-${WORKER_PB_USERNAME:-}}
WEB_PB_PASSWORD=${WEB_PB_PASSWORD:-${WORKER_PB_PASSWORD:-}}
HEALTH_DEBUG_TOKEN=${HEALTH_DEBUG_TOKEN:-}
HEALTH_STALE_SECONDS=${HEALTH_STALE_SECONDS:-90}
ADMIN_EMAILS=${ADMIN_EMAILS:-}
VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY:-}
# Secure flag on the auth cookie (#394). Defaults to on; set false ONLY for a
# fleet served over plain HTTP, such as the libvirt dev VMs — a browser silently
# discards a Secure cookie on an http:// origin, and the symptom is a sign-in that
# bounces back to /signin as though the password were wrong.
COOKIE_SECURE=${COOKIE_SECURE:-true}
EOF
}
# public_worker_config_ok — what a public worker cannot run without. Prints
# what is missing and returns 1, so callers decide whether that is fatal.
public_worker_config_ok() {
  local v ok=0
  for v in PB_HOSTNAME WORKER_CF_ACCESS_CLIENT_ID WORKER_CF_ACCESS_CLIENT_SECRET; do
    [ -n "${!v:-}" ] || { echo "   a public worker needs $v, and it is not set."; ok=1; }
  done
  [ "$ok" = 0 ] || echo "   WORKER_CF_ACCESS_* are written by infra-access; PB_HOSTNAME is in deploy/environments/<env>.vars."
  return "$ok"
}

# public_pb_url — PocketBase as a node OUTSIDE the private network reaches it:
# through the tunnel, at the Access-gated hostname. PB_URL is the private address,
# which such a node has no route to (#498).
public_pb_url() {
  printf 'https://%s' "${PB_HOSTNAME:?set PB_HOSTNAME (a public worker reaches PocketBase at it)}"
}

worker_env() { # zone ip [public]
  # A public worker (provision.sh marks it: a Hetzner location outside the private
  # network's zone) gets the tunnel URL and a service token, and NO private subnet
  # — ensure-private-net.sh would otherwise wait for a 10.x address that will
  # never come and fail the deploy.
  local url="$PB_URL" cf_id="" cf_secret="" subnet="${PRIVATE_SUBNET:-}"
  if [ "${3:-}" = public ]; then
    url="$(public_pb_url)" || return 1
    cf_id="${WORKER_CF_ACCESS_CLIENT_ID:?a public worker needs WORKER_CF_ACCESS_CLIENT_ID — run infra-access}"
    cf_secret="${WORKER_CF_ACCESS_CLIENT_SECRET:?a public worker needs WORKER_CF_ACCESS_CLIENT_SECRET — run infra-access}"
    subnet=""
  fi
  cat <<EOF
PB_URL=${url}
PB_AUTH_COLLECTION=${PB_AUTH_COLLECTION}
# Blank for a node on the private network; set for one that comes in through the
# tunnel (a public worker, or the Fly worker).
CF_ACCESS_CLIENT_ID=${cf_id}
CF_ACCESS_CLIENT_SECRET=${cf_secret}
PB_ADMIN_USERNAME=${WORKER_PB_USERNAME:?set WORKER_PB_USERNAME in $ENV_FILE}
PB_ADMIN_PASSWORD=${WORKER_PB_PASSWORD:?set WORKER_PB_PASSWORD in $ENV_FILE}
REGION_NAME=${1}
PRIVATE_SUBNET=${subnet}
# The anonymous "free" zone runs untrusted URLs, so it enforces the SSRF guard
# (#268); real zones leave it off. Empty here = off (worker.yml default).
BLOCK_PRIVATE_TARGETS=$([ "${1}" = "free" ] && echo true)
HEALTH_DEBUG_TOKEN=${HEALTH_DEBUG_TOKEN:-}
# A range, not a single port (#311): N replicas on one node each need their own
# host port, and a fixed one allows exactly one container.
HEALTH_PORT_RANGE=${HEALTH_PORT_RANGE:-8080-8099}
# A STABLE id for this worker, and stability is the point: it orders the zone's
# roster and so decides which monitors this worker checks. Derived from the zone
# and the node address, both of which survive a redeploy — unlike a container id,
# which is new every time and makes the zone see dead workers beside live ones
# for a whole roster TTL after each deploy.
#
# Extra replicas on this node append their number to it (deploy/worker.yml), so
# they are unique to each other and stable across deploys too.
WORKER_ID=${WORKER_ID:-$(printf '%s-%s' "${1}" "$(printf '%s' "${2}" | tr -c 'a-zA-Z0-9' '-')")}
WORKER_CONCURRENCY=${WORKER_CONCURRENCY:-}
# Workers to run on THIS node. A zone may now hold any number of workers, on any
# number of hosts; they split the monitors between them by roster position.
WORKER_REPLICAS=${WORKER_REPLICAS:-1}
BUILD_VERSION=${BUILD_VERSION}
BUILD_COMMIT=${BUILD_COMMIT}
EOF
}
# deploy_fly ships the worker to a Fly.io app: same repo, same dockerfile, same
# commit as the VMs in this run.
#
# It uses the LOCAL fly CLI and whatever credentials it already has. There is no
# Fly token in the env file and no Fly step in CI: the operator who can deploy the
# fleet is the operator who is logged into Fly.
deploy_fly() { # app zone region
  local app="$1" zone="$2" region="${3:-ams}"
  command -v fly >/dev/null 2>&1 || command -v flyctl >/dev/null 2>&1 \
    || { echo "error: NODES lists a 'fly' worker but the fly CLI is not installed." >&2
         echo "  Install it (https://fly.io/docs/flyctl/install/) and 'fly auth login', or remove the line." >&2
         exit 1; }
  local FLY; FLY="$(command -v fly || command -v flyctl)"

  echo "==> fly worker  $app  (zone=$zone region=$region)"

  # Secrets first: a deploy with a missing PB_URL would start a worker that
  # cannot authenticate and then crash-loop. `--stage` so nothing is released
  # until the image is built and deployed below.
  "$FLY" secrets set --app "$app" --stage \
    PB_URL="${PB_URL:?set PB_URL}" \
    PB_ADMIN_USERNAME="${WORKER_PB_USERNAME:?set WORKER_PB_USERNAME in $ENV_FILE}" \
    PB_ADMIN_PASSWORD="${WORKER_PB_PASSWORD:?set WORKER_PB_PASSWORD in $ENV_FILE}" \
    REGION_NAME="$zone" \
    WORKER_ID="${zone}-fly-${region}" \
    WORKER_CONCURRENCY="${WORKER_CONCURRENCY:-}" \
    HEALTH_DEBUG_TOKEN="${HEALTH_DEBUG_TOKEN:-}" \
    CF_ACCESS_CLIENT_ID="${FLY_CF_ACCESS_CLIENT_ID:?set FLY_CF_ACCESS_CLIENT_ID in $ENV_FILE}" \
    CF_ACCESS_CLIENT_SECRET="${FLY_CF_ACCESS_CLIENT_SECRET:?set FLY_CF_ACCESS_CLIENT_SECRET in $ENV_FILE}" \
    >/dev/null

  # Build context is the repo root: worker/dockerfile copies corelib/, which
  # lives outside worker/.
  ( cd "$REPO_ROOT" && "$FLY" deploy . \
      --config fly/fly.toml \
      --dockerfile worker/dockerfile \
      --app "$app" \
      --primary-region "$region" \
      --build-arg "BUILD_VERSION=${BUILD_VERSION}" \
      --build-arg "BUILD_COMMIT=${BUILD_COMMIT}" )

  # Exactly one machine. Two would be two workers in the zone: the roster copes,
  # but nobody asked for it and it doubles this app's bill.
  "$FLY" scale count 1 --app "$app" --yes >/dev/null 2>&1 || true
  echo "   fly worker $app deployed"
}

evaluator_env() {
  cat <<EOF
PB_URL=${PB_URL}
PB_AUTH_COLLECTION=${PB_AUTH_COLLECTION}
PB_ADMIN_USERNAME=${EVALUATOR_PB_USERNAME:?set EVALUATOR_PB_USERNAME in $ENV_FILE}
PB_ADMIN_PASSWORD=${EVALUATOR_PB_PASSWORD:?set EVALUATOR_PB_PASSWORD in $ENV_FILE}
SMTP_HOST=${SMTP_HOST:-}
SMTP_PORT=${SMTP_PORT:-587}
SMTP_USERNAME=${SMTP_USERNAME:-}
SMTP_PASSWORD=${SMTP_PASSWORD:-}
SMTP_FROM=${SMTP_FROM:-}
OPS_WEBHOOK_URL=${OPS_WEBHOOK_URL:-}
HEALTHCHECK_PING_URL=${HEALTHCHECK_PING_URL:-}
DEADMAN_SECONDS=${DEADMAN_SECONDS:-90}
CERT_EXPIRY_WARN_DAYS=${CERT_EXPIRY_WARN_DAYS:-14}
PRIVATE_SUBNET=${PRIVATE_SUBNET:-}
HEALTH_DEBUG_TOKEN=${HEALTH_DEBUG_TOKEN:-}
HEALTH_PORT=${HEALTH_PORT:-8080}
VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY:-}
VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY:-}
VAPID_SUBJECT=${VAPID_SUBJECT:-${WEB_URL:-}}
BUILD_VERSION=${BUILD_VERSION}
BUILD_COMMIT=${BUILD_COMMIT}
EOF
}

# --- readiness gate ---------------------------------------------------------
# The failure this guards against is a quiet one: worker/evaluator authenticate
# to PocketBase with NewClientWithRetry, which retries FOREVER on failure, and
# an unhealthy container is never restarted by `restart: unless-stopped`. So a
# deploy against a PocketBase that is missing its schema or its service accounts
# exits 0, prints "All nodes deployed", and leaves the fleet spinning in an auth
# loop that only shows up in `docker ps` or the container logs.
#
# Prove the thing the nodes actually need — this role's service account can log
# in AND read a collection — before shipping anything to a node.
# Set SKIP_PB_READINESS=1 to bypass (e.g. PB unreachable from here by design).
# Run FROM A NODE, not from here (#338). Once PocketBase is on the Hetzner
# private network, PB_URL is a 10.x address the deploying machine cannot reach —
# checking from here would abort every single deploy. The probes are unchanged;
# only the vantage point moves to a host that shares the private network.
# Can THIS node reach PocketBase at all? pb_ready answers "are the credentials and
# schema right", which is a property of PocketBase and needs only one vantage
# point. This answers "does this particular machine have a route", which is a
# property of the node — and the two are not the same question.
#
# Staging deployed a worker whose private NIC was never configured: the cloud API
# reported the address attached, PocketBase was listening on it, the firewall
# allowed it, and pb_ready passed because it ran from the PocketBase node. The
# worker itself could not route there, retried auth forever, was never marked
# unhealthy, and the deploy reported success.
#
# Uses bash's /dev/tcp rather than curl: this runs before the node has been given
# any packages, and a missing curl would abort the deploy instead of testing it.
pb_route_ok() { # role ip
  local role="$1" ip="$2" hostport host port
  hostport="${PB_URL#*://}"; hostport="${hostport%%/*}"
  host="${hostport%%:*}"; port="${hostport##*:}"
  [ "$port" != "$host" ] || port=80
  # Retried, because this runs seconds after the pocketbase node was deployed and
  # PocketBase does not finish binding the moment compose returns. A single probe
  # made that race abort the whole run — reported as a private-network fault,
  # which sends you looking at the NIC instead of waiting five seconds.
  local attempt
  for attempt in 1 2 3 4 5; do
    # </dev/null: this probe has nothing to send, and an ssh left holding the
    # caller's stdin reads whatever the caller is iterating over (#508).
    if sshc "$ip" "timeout 8 bash -c 'exec 3<>/dev/tcp/${host}/${port}'" >/dev/null 2>&1 </dev/null; then
      [ "$attempt" = "1" ] || echo "   route to ${host}:${port} from $ip came up on attempt $attempt"
      return 0
    fi
    [ "$attempt" = "5" ] || sleep 5
  done
  echo "PRIVATE ROUTE FAILED for $role at $ip: cannot open ${host}:${port}."
  echo "  PocketBase is reachable from elsewhere, so this is this node's network, not PB."
  echo "  The usual cause is a Hetzner private NIC attached cloud-side but never"
  echo "  configured in the guest — cloud-init wrote its config before the attach."
  echo "  Check 'ip -4 addr' on the node; a reboot regenerates it."
  return 1
}

# pb_public_ready — the readiness gate for a public worker, run ON that worker.
# pb_ready and pb_route_ok both test the private path, which this node never
# uses; what it depends on is the tunnel, Cloudflare Access letting its service
# token through, and the worker account — so prove all three from where they
# matter. A wrong or missing token is a 403 from Access here, rather than a
# worker that retries auth forever and looks healthy from the outside.
pb_public_ready() { # ip
  local ip="$1" url remote
  url="$(public_pb_url)"
  remote="$(printf 'PB_URL=%q COLL=%q PB_U=%q PB_P=%q CF_ID=%q CF_SECRET=%q bash -s' \
    "$url" "$PB_AUTH_COLLECTION" "${WORKER_PB_USERNAME:-}" "${WORKER_PB_PASSWORD:-}" \
    "${WORKER_CF_ACCESS_CLIENT_ID:-}" "${WORKER_CF_ACCESS_CLIENT_SECRET:-}")"
  local attempt rc
  for attempt in 1 2 3 4 5; do
    rc=0
    sshc "$ip" "$remote" >/dev/null 2>&1 <<'REMOTE' || rc=$?
tok="$(curl -fsS --max-time 15 -H 'Content-Type: application/json' \
  -H "CF-Access-Client-Id: ${CF_ID}" -H "CF-Access-Client-Secret: ${CF_SECRET}" \
  -d "{\"identity\":\"${PB_U}\",\"password\":\"${PB_P}\"}" \
  "${PB_URL%/}/api/collections/${COLL}/auth-with-password" \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$tok" ] || exit 1
curl -fsS --max-time 15 -H "Authorization: $tok" \
  -H "CF-Access-Client-Id: ${CF_ID}" -H "CF-Access-Client-Secret: ${CF_SECRET}" \
  "${PB_URL%/}/api/collections/monitors/records?perPage=1&skipTotal=true" >/dev/null || exit 2
REMOTE
    if [ "$rc" = 0 ]; then
      echo "   readiness: public worker $ip authenticates through Access at $url"
      return 0
    fi
    # The tunnel connector starts with the pocketbase node, seconds before this.
    [ "$attempt" = "5" ] || sleep 5
  done
  echo "PocketBase readiness FAILED for the public worker at $ip, through $url."
  echo "  Its path is the tunnel and Cloudflare Access, not the private network. Check that"
  echo "  the tunnel connector is up, that WORKER_CF_ACCESS_* is a token on the Access policy"
  echo "  for $PB_HOSTNAME (infra-access mints it), and the worker credentials."
  return 1
}

# check_node_routes — the per-node half of the readiness gate: every
# non-PocketBase node in NODES proves its own path to PocketBase. Returns 1 if
# any node fails, after checking all of them.
#
# NODES is read on fd 3, not stdin, and that is the point (#508): the checks run
# ssh, which reads its stdin, so a `while read … done <<<"$NODES"` loop had its
# remaining lines eaten by the first node's ssh. The gate checked one node and
# skipped the rest — on production, both workers.
check_node_routes() {
  local role ip _zone extra _ rc=0
  while read -r role ip _zone extra _ <&3; do
    # `fly` is skipped: its second field is an app name, not a host we can ssh
    # into, and it reaches PocketBase over the public tunnel rather than the
    # private network this probe is testing. Its route is proven by the deploy
    # itself — a worker that cannot authenticate crash-loops visibly.
    case "${role:-}" in "" | \#* | pocketbase | fly | 'NODES="' | '"') continue ;; esac
    [ -n "${ip:-}" ] || continue
    if [ "$role" = worker ] && [ "${extra:-}" = public ]; then
      pb_public_ready "$ip" || rc=1
    else
      pb_route_ok "$role" "$ip" || rc=1
    fi
  done 3<<<"$NODES"
  return "$rc"
}

pb_ready() { # role ENVPREFIX username password
  local role="$1" prefix="$2" user="$3" pass="$4" remote
  # Missing credentials used to "skip" — returning success for the condition with
  # the largest blast radius, and the same condition that truncates the node's env
  # file. The role is in NODES, so its credentials are required; absent is a
  # failure, not an exemption.
  [ -n "$user" ] && [ -n "$pass" ] || {
    echo "   readiness: ${prefix}_PB_USERNAME/${prefix}_PB_PASSWORD are not set, but a"
    echo "   '$role' node is listed in NODES. It cannot authenticate to PocketBase,"
    echo "   and its env file would be written empty. Set them in $ENV_FILE."
    return 1
  }
  if [ -z "${GATE_HOST:-}" ]; then
    echo "   readiness: no node available to check from — skipping"
    return 0
  fi
  # Values are quoted for the remote shell here; the remote script only ever
  # expands them as variables.
  remote="$(printf 'PB_URL=%q COLL=%q PB_U=%q PB_P=%q bash -s' \
    "$PB_URL" "$PB_AUTH_COLLECTION" "$user" "$pass")"
  if sshc "$GATE_HOST" "$remote" >/dev/null 2>&1 <<'REMOTE'
tok="$(curl -fsS --max-time 15 -H 'Content-Type: application/json' \
  -d "{\"identity\":\"${PB_U}\",\"password\":\"${PB_P}\"}" \
  "${PB_URL%/}/api/collections/${COLL}/auth-with-password" \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$tok" ] || exit 1
curl -fsS --max-time 15 -H "Authorization: $tok" \
  "${PB_URL%/}/api/collections/monitors/records?perPage=1&skipTotal=true" >/dev/null || exit 2
REMOTE
  then
    echo "   readiness: $role account authenticates and can read monitors (checked from $GATE_HOST)"
    return 0
  fi
  echo "PocketBase readiness FAILED for $role at $PB_URL (checked from $GATE_HOST)."
  echo "  Either the '$PB_AUTH_COLLECTION' collection / the $role account is missing — deploy the"
  echo "  'pocketbase' node first (setup-pocketbase.sh imports the schema and seeds the accounts) —"
  echo "  or ${prefix}_PB_USERNAME/${prefix}_PB_PASSWORD in $ENV_FILE are wrong, or the node cannot"
  echo "  reach PB_URL over the private network."
  echo "  Refusing to deploy $role: it would retry auth forever and look healthy from the outside."
  return 1
}

# Deploy pocketbase FIRST regardless of where its line sits in NODES: it imports
# the schema and seeds the service accounts every other role authenticates with.
# Two passes rather than a documented ordering rule nobody re-reads.
deploy_node() { # role ip zone extra
  local role="$1" ip="$2" zone="$3" extra="${4:-}"
  case "$role" in
    pocketbase)
      [ -n "${ip:-}" ] || { echo "bad NODES line (need: pocketbase <ip>): $role"; exit 1; }
      echo "==> pocketbase  $ip"
      push_env "$ip" pocketbase "$(pocketbase_env)"
      push_code "$ip"
      run_setup "$ip" pocketbase
      ;;
    worker)
      # NODES line: worker <ip> <zone> [public]
      [ -n "${ip:-}" ] && [ -n "${zone:-}" ] || { echo "bad NODES line (need: worker <ip> <zone> [public]): $role $ip $zone"; exit 1; }
      case "$extra" in "" | public) ;; *) echo "bad NODES line: worker 4th field must be 'public' or empty, got '$extra'"; exit 1 ;; esac
      # Checked HERE, not only inside worker_env: that runs in a command
      # substitution, where a failed ${VAR:?} does not stop this script — it would
      # push a truncated env file and carry on.
      if [ "$extra" = public ]; then
        public_worker_config_ok || exit 1
      fi
      echo "==> worker  $ip  (zone=$zone${extra:+, $extra — PocketBase via $(public_pb_url)})"
      push_env "$ip" worker "$(worker_env "$zone" "$ip" "$extra")"
      push_code "$ip"
      run_setup "$ip" worker
      ;;
    fly)
      # A worker on Fly.io rather than a VM we ssh into. Same zone, same image,
      # same commit — deployed here rather than by a separate workflow so two
      # workers in one zone can never be running different versions.
      #
      # NODES line: fly <app-name> <zone> [region]
      [ -n "${ip:-}" ] && [ -n "${zone:-}" ] || { echo "bad NODES line (need: fly <app> <zone> [region]): $role $ip $zone"; exit 1; }
      deploy_fly "$ip" "$zone" "${extra:-}"
      ;;
    evaluator)
      [ -n "${ip:-}" ] || { echo "bad NODES line (need: evaluator <ip>): $role"; exit 1; }
      echo "==> evaluator  $ip"
      push_env "$ip" evaluator "$(evaluator_env)"
      push_code "$ip"
      run_setup "$ip" evaluator
      ;;
    web)
      [ -n "${ip:-}" ] || { echo "bad NODES line (need: web <ip>): $role"; exit 1; }
      echo "==> web  $ip"
      push_env "$ip" web "$(web_env "$ip")"
      push_code "$ip"
      run_setup "$ip" web
      ;;
    # provision.sh prints NODES as a ready-to-paste `NODES="…"` block, so a
    # hand-copied value can carry the wrapper. Skip it rather than reporting the
    # quote character as an unknown role.
    'NODES="' | '"') return 0 ;;
    *) echo "unknown role '$role' in NODES"; exit 1 ;;
  esac
}

# The host the readiness gate runs from: the pocketbase node when there is one
# (it is deployed first and is on the private network), otherwise the first node
# listed — any fleet host shares the network and only needs ssh + curl.
GATE_HOST="$(awk '$1=="pocketbase"{print $2; exit}' <<<"$NODES")"
[ -n "$GATE_HOST" ] || GATE_HOST="$(awk 'NF && $1 !~ /^#/ {print $2; exit}' <<<"$NODES")"

# Single-node mode (#418): ONLY_HOST=<ip> deploys that one NODES line and nothing
# else. Replacing a worker must not redeploy PocketBase — pass 1 re-imports the
# schema — nor any other node. Narrowing NODES to the one line is the whole
# mechanism: pass 1 then finds no pocketbase line, the gate checks only this
# role's credentials and this node's route, and pass 2 deploys only it. GATE_HOST
# was chosen above from the full list, so the credential check still runs from
# the pocketbase node, read-only, as it always does.
if [ -n "${ONLY_HOST:-}" ]; then
  only_line="$(awk -v h="$ONLY_HOST" 'NF && $1 !~ /^#/ && $2==h' <<<"$NODES")"
  only_n="$(grep -c . <<<"$only_line" || true)"
  [ "$only_n" = 1 ] || {
    echo "ONLY_HOST=$ONLY_HOST matches $only_n NODES lines; it must match exactly one." >&2; exit 1; }
  case "$(awk '{print $1}' <<<"$only_line")" in
    worker | evaluator) ;;
    pocketbase)
      echo "ONLY_HOST refuses the pocketbase node: deploying it imports the schema and" >&2
      echo "restarts the database every other node depends on. Run a full deploy for that." >&2
      exit 1 ;;
    *) echo "ONLY_HOST supports worker and evaluator nodes, not: $only_line" >&2; exit 1 ;;
  esac
  echo "==> single-node mode: only '$only_line' — PocketBase, the schema import and every other node are skipped"
  NODES="$only_line"
fi
if [ "${NO_START:-}" = 1 ] && ! awk '$1=="worker" {f=1} END {exit !f}' <<<"${only_line:-}"; then
  echo "NO_START=1 needs ONLY_HOST=<ip> naming a worker: it leaves that worker built but" >&2
  echo "stopped, which is only ever right for the one node being brought in." >&2
  exit 1
fi

# Before anything is touched: a public worker in NODES needs the tunnel hostname
# and its Access token. Missing either is a configuration error, and finding out
# after pass 1 has redeployed PocketBase is the expensive time to find out.
if awk '$1=="worker" && $4=="public" {f=1} END {exit !f}' <<<"$NODES"; then
  public_worker_config_ok || { echo "Aborting before any node was touched."; exit 1; }
fi

# Pass 1 — pocketbase, wherever it appears in NODES.
while read -r role ip zone extra _; do
  case "${role:-}" in "" | \#*) continue ;; pocketbase) deploy_node "$role" "${ip:-}" "${zone:-}" ;; esac
done <<<"$NODES"

# Gate — every remaining role authenticates to PocketBase, so check before we
# ship code to any of them. Only the creds a listed role actually uses.
if [ "${SKIP_PB_READINESS:-}" = "1" ]; then
  echo "==> skipping PocketBase readiness check (SKIP_PB_READINESS=1)"
else
  echo "==> checking PocketBase is ready at $PB_URL"
  ok=1
  # `fly` is a worker too: same service account, same collections, so the same
  # credential check applies to it.
  if grep -qE '^[[:space:]]*(worker|fly)([[:space:]]|$)' <<<"$NODES"; then
    pb_ready worker WORKER "${WORKER_PB_USERNAME:-}" "${WORKER_PB_PASSWORD:-}" || ok=0
  fi
  if grep -qE '^[[:space:]]*evaluator([[:space:]]|$)' <<<"$NODES"; then
    pb_ready evaluator EVALUATOR "${EVALUATOR_PB_USERNAME:-}" "${EVALUATOR_PB_PASSWORD:-}" || ok=0
  fi
  # Then every non-PocketBase node individually. The credential check above shares
  # one vantage point; reachability cannot be shared, because it is exactly what
  # differs between nodes.
  check_node_routes || ok=0
  # Not "before any node was touched": pass 1 above already deployed the
  # pocketbase node, which imports the schema, applies settings and installs the
  # maintenance timer. Saying otherwise invites a rollback decision based on a
  # false premise about the database node.
  [ "$ok" = "1" ] || {
    echo "Aborting before any WORKER or EVALUATOR node was touched."
    if grep -qE '^[[:space:]]*pocketbase([[:space:]]|$)' <<<"$NODES"; then
      echo "  NOTE: the pocketbase node was already deployed above — schema imported,"
      echo "  settings applied, maintenance timer installed. It is not unchanged."
    fi
    echo "  Fix the problem reported above and re-run; the pocketbase step is idempotent."
    exit 1
  }
fi

# Pass 2 — everything else, in file order.
while read -r role ip zone extra _; do
  case "${role:-}" in
    "" | \#* | pocketbase) continue ;;
    *) deploy_node "$role" "${ip:-}" "${zone:-}" "${extra:-}" ;;
  esac
done <<<"$NODES"

if [ -n "${ONLY_HOST:-}" ]; then
  echo "Deployed $ONLY_HOST only${NO_START:+ — containers created, NOT started (NO_START=1)}."
else
  echo "All nodes deployed."
fi
