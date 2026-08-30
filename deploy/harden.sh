#!/usr/bin/env bash
#
# Harden a fresh Ubuntu/Debian node. Idempotent. Called once by the setup
# scripts (guarded by /etc/monitors/.hardened). Safe to run again to re-apply.
#
# Does NOT open any ports the app doesn't need — the worker/evaluator publish
# no ports, so only SSH is reachable.
#
# Lockout safety: the SSH change disables *password* auth only (key login still
# works), and it is applied via a drop-in that is validated with `sshd -t` and
# reloaded (not restarted) — a bad config is rolled back and the live session is
# never dropped. This assumes you connect with an SSH key (the deploy does).
set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "harden.sh must run as root"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> [harden] packages"
apt-get update -y
apt-get install -y ufw unattended-upgrades fail2ban

echo "==> [harden] firewall: allow SSH only, deny other inbound"
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp
# PocketBase listens only on the private network (#338): the worker and evaluator
# reach it at PRIVATE_SUBNET, and the web app comes in through a Cloudflare
# Tunnel, which is outbound-only. Nothing else is opened — there is deliberately
# no public inbound port for PocketBase.
if [ -n "${PRIVATE_SUBNET:-}" ]; then
  echo "==> [harden] allow ${PRIVATE_SUBNET} -> 8090 (private PocketBase)"
  ufw allow from "${PRIVATE_SUBNET}" to any port 8090 proto tcp >/dev/null 2>&1 || true
fi
ufw --force default deny incoming
ufw --force default allow outgoing
ufw --force enable

echo "==> [harden] automatic security updates"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

echo "==> [harden] fail2ban"
systemctl enable --now fail2ban >/dev/null 2>&1 || true

echo "==> [harden] SSH: key-only (password auth off)"
mkdir -p /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/10-monitors-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin prohibit-password
EOF
if sshd -t 2>/dev/null; then
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
else
  echo "!! [harden] sshd config test failed — reverting SSH change, leaving auth untouched"
  rm -f /etc/ssh/sshd_config.d/10-monitors-hardening.conf
fi

echo "==> [harden] done"
