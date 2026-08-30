#!/usr/bin/env bash
#
# Make sure this node actually has its Hetzner private-network interface up.
#
# provision.sh attaches servers to the private network through the Hetzner API and
# notes that "attaching an EXISTING server needs no rebuild: Hetzner images
# configure the new interface via cloud-init / hc-utils". That is only true when
# the attach happens before the guest's first boot. Attach it afterwards and
# cloud-init has already written /etc/netplan/50-cloud-init.yaml WITHOUT the new
# interface, so the NIC exists, stays DOWN, and never gets an address.
#
# The result is the worst kind of failure: every cloud-side check passes — the API
# reports the private IP attached, the firewall rule is right, PocketBase is
# listening on exactly that address — and the node simply cannot route to it. The
# worker then retries auth forever, the container is never marked unhealthy, and
# the deploy reports success. On staging this looked like a healthy fleet that did
# no monitoring at all.
#
# Called by the role setup scripts before anything tries to reach PocketBase.
# Non-fatal when no private network is configured (dev, libvirt, a single-node
# box): there is nothing to bring up and nothing to warn about.
set -euo pipefail

SUBNET="${PRIVATE_SUBNET:-}"
# The env files are written two ways: pocketbase.env goes through remote-deploy's
# kv(), which shell-quotes every value (KEY='10.0.0.0/16'), while the worker and
# evaluator heredocs write them bare. A caller that reads the file with `cut -d=`
# therefore hands us the value with literal quotes attached about a third of the
# time — which made this script compute a prefix of "'10." and declare a perfectly
# configured PocketBase node unreachable. Strip them here, once, rather than in
# each caller.
SUBNET="${SUBNET%\'}"; SUBNET="${SUBNET#\'}"
SUBNET="${SUBNET%\"}"; SUBNET="${SUBNET#\"}"
[ -n "$SUBNET" ] || { echo "==> no PRIVATE_SUBNET set — skipping private-network check"; exit 0; }

# The first octets of the subnet, e.g. 10.0.0.0/16 -> "10." — enough to recognise
# an address on it without pulling in a CIDR library.
prefix="${SUBNET%%.*}."

have_private_ip() { ip -4 -o addr show 2>/dev/null | awk '{print $4}' | grep -q "^${prefix}"; }

if have_private_ip; then
  echo "==> private network up ($(ip -4 -o addr show | awk '{print $4}' | grep "^${prefix}" | head -1))"
  exit 0
fi

echo "==> private network MISSING — no address on ${SUBNET}; repairing"

# Any ethernet interface that is not the public one and has no v4 address. On
# Hetzner this is the private NIC (enp7s0 on current images), but match on shape
# rather than name so an image that renames it still works.
candidates="$(ip -o link show 2>/dev/null \
  | awk -F': ' '{print $2}' | cut -d@ -f1 \
  | grep -vE '^(lo|docker|br-|veth|tun|tap)' || true)"

for ifc in $candidates; do
  ip -4 -o addr show dev "$ifc" 2>/dev/null | grep -q inet && continue   # already addressed
  echo "   bringing up $ifc"
  ip link set "$ifc" up 2>/dev/null || true
done

# Regenerate the netplan config cloud-init wrote before the interface existed.
# `netplan apply` alone is not enough: it re-applies the SAME file, which is
# exactly the one missing this NIC.
if command -v cloud-init >/dev/null 2>&1; then
  echo "   re-running cloud-init network config"
  cloud-init clean --logs >/dev/null 2>&1 || true
  cloud-init init --local >/dev/null 2>&1 || true
fi
command -v netplan >/dev/null 2>&1 && { netplan apply >/dev/null 2>&1 || true; }

# Last resort: ask DHCP directly on each candidate. Hetzner serves the private
# address over DHCP, so this works even when the declarative config is wrong.
if ! have_private_ip && command -v dhclient >/dev/null 2>&1; then
  for ifc in $candidates; do
    ip -4 -o addr show dev "$ifc" 2>/dev/null | grep -q inet && continue
    echo "   dhclient $ifc"
    timeout 20 dhclient -1 "$ifc" >/dev/null 2>&1 || true
  done
fi

for _ in $(seq 1 10); do have_private_ip && break; sleep 2; done

if have_private_ip; then
  echo "   recovered: $(ip -4 -o addr show | awk '{print $4}' | grep "^${prefix}" | head -1)"
  exit 0
fi

# Fail loudly rather than deploying a node that cannot reach PocketBase. A reboot
# makes cloud-init regenerate the config with the interface present, which is what
# actually fixed this on staging.
cat >&2 <<EOF
ERROR: this node has no address on the private network ${SUBNET}.

  Interfaces:
$(ip -o link show | awk -F': ' '{print "    " $2}' | cut -d@ -f1)

  It is attached cloud-side but the guest never configured the interface —
  cloud-init wrote its network config before the network was attached. A reboot
  regenerates it. Reboot this host and re-run the deploy.

  Continuing would deploy a node that cannot reach PocketBase: it would retry
  authentication forever, never be marked unhealthy, and the deploy would report
  success while the node does nothing.
EOF
exit 1
