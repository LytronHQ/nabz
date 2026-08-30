#!/usr/bin/env bash
#
# provision.sh — create the nabz production fleet on Hetzner Cloud, then print a
# ready-to-paste NODES block for the environment's Bitwarden project. Same spirit as
# deploy/vm/create-vm.virt-manager.sh (local libvirt) but against Hetzner Cloud:
# plain bash + the provider's HTTP API, no Terraform/Ansible, idempotent.
#
#   HCLOUD_TOKEN=… SSH_PRIVATE_KEY="$(cat ~/.ssh/id_hetzner)" ./deploy/hetzner/provision.sh
#
# It creates THREE servers (looked up by name first, so re-running is a no-op):
#
#   nabz-pocketbase          fsn1 (Falkenstein)  datastore + auth  (role pocketbase)
#   nabz-evaluator           fsn1 (Falkenstein)  incidents/alerts  (role evaluator)
#   nabz-worker-eu-central-1 fsn1 (Falkenstein)  probe zone        (role worker, zone eu-central)
#
# ONE zone for now, deliberately. A second region is wanted — single-zone
# consensus can't outvote a bad network path (evaluator/consensus.go), so with
# one zone the evaluator falls back to the N-consecutive-failures rule instead of
# cross-zone agreement. But the cx line we buy is EU-only, and the US/APAC
# alternatives cost 3x (cpx11 in ash is EUR 17.49/mo vs EUR 5.49). A second zone
# goes in when Hetzner makes those locations purchasable on a comparable plan;
# there is no interim US VM. It only *creates the servers*; the
# actual deploy is still `./deploy/remote-deploy.sh prod`, which consumes the
# NODES block this prints. Hardening (ufw, key-only SSH, …) runs on-host via
# deploy/harden.sh during that deploy — not here.
#
# Required env:
#   HCLOUD_TOKEN   Hetzner Cloud API token (Project → Security → API tokens,
#                  Read & Write). The operator creates this.
#   SSH_PRIVATE_KEY  The deploy key, whole. Its fingerprint is matched against
#                  the keys registered in the Hetzner project to find which one
#                  to attach at creation — so there is no separate key NAME to
#                  keep in sync, and it is impossible to attach a public key
#                  whose private half you do not hold.
#
# Optional env:
#   SSH_KEY_NAME      Skip the fingerprint lookup and use this Hetzner key name
#                     verbatim. Escape hatch; normally unset.
#   SERVER_TYPE       Hetzner server type (default cx23 — 2 vCPU / 4 GB / 40 GB,
#                     €5.49/mo). NOTE: the cx line is EU-only (fsn1/hel1/nbg1);
#                     see the preflight check below.
#   FLEET_ROLES       Comma-separated roles to provision, for standing up a
#                     subset (e.g. FLEET_ROLES=pocketbase for a throwaway test
#                     of the volume path). Default: the whole fleet.
#   IMAGE             OS image (default ubuntu-24.04).
#   SERVER_PREFIX     Name prefix for the fleet (default nabz-).
set -euo pipefail

API="https://api.hetzner.cloud/v1"
SERVER_TYPE="${SERVER_TYPE:-cx23}"
IMAGE="${IMAGE:-ubuntu-24.04}"
SERVER_PREFIX="${SERVER_PREFIX:-nabz-}"

die() { echo "error: $*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || die "missing 'curl'"
command -v jq   >/dev/null 2>&1 || die "missing 'jq' — sudo apt install -y jq"
: "${HCLOUD_TOKEN:?set HCLOUD_TOKEN (Hetzner Cloud API token, Read & Write)}"
: "${SSH_PRIVATE_KEY:?set SSH_PRIVATE_KEY (the deploy key itself; its fingerprint selects the Hetzner key)}"

# The fleet: "suffix:location:role:zone". zone is only meaningful for workers.
# PocketBase first so it's up before the others authenticate against it.
#
# Naming convention (aligns with the zone-identity model in #311):
#   worker servers are  ${SERVER_PREFIX}worker-<zone_code>-<n>  (n per-zone, from 1)
#   — the index is ops identity only; a second VM in a zone is …-eu-central-2 and
#   never renames the first. The ZONE emitted in NODES is the BARE zone_code
#   (eu-central), with no index: the index must never leak into checks.zone / the
#   `due:<zone>` queue key. Zone codes are final-granularity + immutable
#   (changing one is a data migration); display names live in the DB, not here.
FLEET=(
  "pocketbase:fsn1:pocketbase:"
  "evaluator:fsn1:evaluator:"
  "worker-eu-central-1:fsn1:worker:eu-central"
)

# urlenc — percent-encode a value for use in a query string. Hetzner's DEFAULT
# SSH key name is "user@host [project]", and interpolating that raw into a URL
# makes curl fail with "bad range in URL" before the request is even sent.
urlenc() { jq -rn --arg s "$1" '$s|@uri'; }

# api METHOD PATH [json-body] — call the Hetzner Cloud API, fail on HTTP >= 400
# with the API's own error message (it returns {error:{message}}).
api() {
  local method="$1" path="$2" body="${3:-}" out code
  out="$(mktemp)"
  if [ -n "$body" ]; then
    code="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$API$path" \
      -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' \
      -d "$body")"
  else
    code="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$API$path" \
      -H "Authorization: Bearer $HCLOUD_TOKEN")"
  fi
  if [ "$code" -ge 400 ]; then
    echo "error: Hetzner API $method $path -> HTTP $code: $(jq -r '.error.message // .' "$out" 2>/dev/null)" >&2
    rm -f "$out"; exit 1
  fi
  cat "$out"; rm -f "$out"
}

# --- preflight: is SERVER_TYPE actually sold everywhere the fleet wants it? ---
# Hetzner sells different server lines in different regions — the cheap shared
# `cx` line is EU-only, so a fleet entry in ash/hil/sin silently fails at create
# time, AFTER the earlier servers already exist. Check up front and refuse, with
# the list of locations that would work, instead of half-provisioning.
TYPE_LOCS="$(api GET "/server_types?name=$SERVER_TYPE" | jq -r '.server_types[0].prices[]?.location' | sort -u)"
[ -n "$TYPE_LOCS" ] || die "server type '$SERVER_TYPE' does not exist (or is not available on this account). Check https://console.hetzner.cloud → Servers → Add Server."
for entry in "${FLEET[@]}"; do
  IFS=: read -r _suffix loc role _zone <<<"$entry"
  case ",${FLEET_ROLES:-},"  in *,,*) ;; *",$role,"*) ;; *) continue ;; esac
  grep -qx "$loc" <<<"$TYPE_LOCS" || die "server type '$SERVER_TYPE' is not available in '$loc' (wanted by the $role node).
  '$SERVER_TYPE' is sold in: $(tr '\n' ' ' <<<"$TYPE_LOCS")
  Either move that node to one of those locations (edit FLEET), or set SERVER_TYPE to a
  line that is sold in '$loc' — the shared 'cx' types are EU-only, US/APAC need 'cpx'/'ccx'
  at 3x the price. Refusing to provision a partial fleet."
done

# --- SSH key: identify it by FINGERPRINT, not by name -------------------------
# The private key we deploy with and the public key Hetzner installs must be the
# same pair. Naming them separately lets them drift, and the failure is silent:
# provisioning succeeds, then the first ssh fails because the box carries a key
# nobody holds. Deriving the name from the key removes the possibility.
if [ -z "${SSH_KEY_NAME:-}" ]; then
  command -v ssh-keygen >/dev/null 2>&1 || die "missing 'ssh-keygen'"
  keyfile="$(mktemp)"; trap 'rm -f "$keyfile"' EXIT
  printf '%s\n' "$SSH_PRIVATE_KEY" > "$keyfile"; chmod 600 "$keyfile"
  # Hetzner reports MD5 fingerprints of the PUBLIC key, colon-separated.
  FPR="$(ssh-keygen -l -E md5 -f "$keyfile" 2>/dev/null | awk '{print $2}' | sed 's/^MD5://')" \
    || die "could not read SSH_PRIVATE_KEY — is it the whole key, including the BEGIN/END lines?"
  [ -n "$FPR" ] || die "could not fingerprint SSH_PRIVATE_KEY."

  SSH_KEY_NAME="$(api GET "/ssh_keys?per_page=50" \
    | jq -r --arg f "$FPR" '.ssh_keys[] | select(.fingerprint == $f) | .name' | head -1)"
  if [ -z "$SSH_KEY_NAME" ]; then
    echo "==> uploading this key to the Hetzner project as '${SERVER_PREFIX}deploy'"
    pub="$(ssh-keygen -y -f "$keyfile")" || die "could not derive the public key from SSH_PRIVATE_KEY."
    body="$(jq -nc --arg n "${SERVER_PREFIX}deploy" --arg k "$pub" '{name:$n, public_key:$k}')"
    SSH_KEY_NAME="$(api POST "/ssh_keys" "$body" | jq -r '.ssh_key.name')"
  fi
  rm -f "$keyfile"; trap - EXIT
fi
echo "· deploy key: $SSH_KEY_NAME"

# Public IPv4/IPv6 are ON by default, deliberately, and the reason is egress
# rather than access. Hetzner gives a private-only server no route off the network
# and offers no managed NAT, so private-only means running a gateway — and that
# gateway is a single point of failure for CHECKING, not just for management: if
# it dies, every worker stops probing at once. Public IPs put each node's egress
# on its own independent path, which for a monitoring product is the safer
# failure mode, and cheaper than a gateway server at ~€0.50/mo per address.
#
# Nothing is exposed by having one: harden.sh runs ufw with SSH as the only
# inbound port, key-only, with fail2ban, and PocketBase is reached through the
# Cloudflare Tunnel, which is an outbound connection.
#
# Set PUBLIC_IPV4=false once a NAT gateway exists; the preflight below refuses
# until it does.
PUBLIC_IPV4="${PUBLIC_IPV4:-true}"
PUBLIC_IPV6="${PUBLIC_IPV6:-true}"
case "$PUBLIC_IPV4" in true|false) ;; *) die "PUBLIC_IPV4 must be true or false" ;; esac
case "$PUBLIC_IPV6" in true|false) ;; *) die "PUBLIC_IPV6 must be true or false" ;; esac

# Egress preflight. Hetzner gives a private-only server no route off the network,
# and provides no managed NAT — you run your own gateway and add a 0.0.0.0/0 route
# to it. Without that the server cannot apt-get, cannot docker pull, cannot reach
# Cloudflare for the tunnel, and — the one that actually matters — a worker cannot
# probe a single customer URL. Checked here rather than discovered on a host that
# will not finish its setup script.
NAT_ROUTE=""
if [ "$PUBLIC_IPV4" = false ]; then
  _net="$(api GET "/networks?name=$(urlenc "${PRIVATE_NETWORK:-${SERVER_PREFIX}vnet}")")"
  NAT_ROUTE="$(jq -r '.networks[0].routes[]? | select(.destination == "0.0.0.0/0") | .gateway' <<<"$_net" | head -1)"
fi
require_egress() { # called only when we are about to CREATE a private-only server
  [ "$PUBLIC_IPV4" = false ] || return 0
  [ -z "$NAT_ROUTE" ] || return 0
  [ "${ALLOW_NO_EGRESS:-0}" = 1 ] && {
    echo "!! creating private-only servers with NO internet egress (ALLOW_NO_EGRESS=1)" >&2
    return 0
  }
  die "PUBLIC_IPV4=false but '${PRIVATE_NETWORK:-${SERVER_PREFIX}vnet}' has no 0.0.0.0/0 route.
  A server with no public IP has no way off the private network, so it cannot
  install Docker, pull an image, open the Cloudflare Tunnel, or — for a worker —
  run a single check. Hetzner has no managed NAT: add a gateway server with a
  public IP and a 0.0.0.0/0 route to it, or set PUBLIC_IPV4=true.
  ALLOW_NO_EGRESS=1 overrides, if you are adding the gateway next."
}

# --- placement group + firewall, both before any server exists ----------------
# Order matters. A placement group can only be set AT CREATION — Hetzner has no
# "move an existing server into a group" — and the firewall must already carry its
# label selector so a server is covered the moment it comes up rather than in the
# window between create and attach.
: "${ENVIRONMENT:?set ENVIRONMENT (production|staging) — it names the placement group and firewall, and is the label the firewall selects on}"
PLACEMENT_GROUP="${PLACEMENT_GROUP:-${SERVER_PREFIX}spread}"
FIREWALL_NAME="${FIREWALL_NAME:-${SERVER_PREFIX}fw}"

# Spread: Hetzner keeps the members on different physical hosts, so one host
# failing cannot take the whole fleet. Capped at 10 servers in a single location,
# which the 3-server EU-only fleet is nowhere near.
PG_ID="$(api GET "/placement_groups?name=$(urlenc "$PLACEMENT_GROUP")" | jq -r '.placement_groups[0].id // empty')"
if [ -n "$PG_ID" ]; then
  echo "· placement group $PLACEMENT_GROUP already exists (id $PG_ID)"
else
  PG_ID="$(api POST "/placement_groups" "$(jq -nc --arg n "$PLACEMENT_GROUP" --arg e "$ENVIRONMENT" \
    '{name:$n, type:"spread", labels:{project:"nabz", env:$e}}')" | jq -r '.placement_group.id')"
  echo "==> created placement group $PLACEMENT_GROUP (spread, id $PG_ID)"
fi

# One firewall for the environment, attached by LABEL SELECTOR rather than to each
# server. A server created later with env=<environment> is protected without
# anyone remembering to attach it — the per-server form fails open, silently, at
# exactly the moment a new node joins.
#
# SSH only. Everything else the fleet does is outbound: the workers probe, the
# tunnel dials out, PocketBase is reached through it. Hetzner firewalls default to
# allowing all egress when no outbound rule is given, which is what we want.
FW_RULES='[{"direction":"in","protocol":"tcp","port":"22","source_ips":["0.0.0.0/0","::/0"]}]'
FW_APPLY="$(jq -nc --arg sel "env=$ENVIRONMENT" \
  '[{type:"label_selector", label_selector:{selector:$sel}}]')"
FW_JSON="$(api GET "/firewalls?name=$(urlenc "$FIREWALL_NAME")")"
FW_ID="$(jq -r '.firewalls[0].id // empty' <<<"$FW_JSON")"
if [ -n "$FW_ID" ]; then
  # Converge rather than assume, so a hand-edit in the console (an extra open
  # port, a dropped selector) is undone on the next run. set_rules replaces the
  # whole set and is safe to repeat; apply_to_resources is NOT — it 422s with
  # "firewall has already been applied to resource" — so only call it when the
  # selector is actually missing.
  api POST "/firewalls/$FW_ID/actions/set_rules" "$(jq -nc --argjson r "$FW_RULES" '{rules:$r}')" >/dev/null
  if ! jq -e --arg sel "env=$ENVIRONMENT" \
      '.firewalls[0].applied_to[]? | select(.type == "label_selector") | select(.label_selector.selector == $sel)' \
      >/dev/null <<<"$FW_JSON"; then
    api POST "/firewalls/$FW_ID/actions/apply_to_resources" "$(jq -nc --argjson a "$FW_APPLY" '{apply_to:$a}')" >/dev/null
    echo "   re-attached selector env=$ENVIRONMENT"
  fi
  echo "· firewall $FIREWALL_NAME reconciled (id $FW_ID) — SSH only, selector env=$ENVIRONMENT"
else
  FW_ID="$(api POST "/firewalls" "$(jq -nc --arg n "$FIREWALL_NAME" --arg e "$ENVIRONMENT" \
    --argjson r "$FW_RULES" --argjson a "$FW_APPLY" \
    '{name:$n, rules:$r, apply_to:$a, labels:{project:"nabz", env:$e}}')" | jq -r '.firewall.id')"
  echo "==> created firewall $FIREWALL_NAME (id $FW_ID) — SSH only, selector env=$ENVIRONMENT"
fi

# Exactly one firewall per environment. Any other one under our prefix is a
# leftover — the project still held nabz-pocketbase-firewall,
# nabz-evaluator-firewall and nabz-workers-firewall from the per-role era, and two
# firewalls on one server UNION their rules, so a stale one silently widens the
# surface the moment someone adds a rule to it.
#
# Matched on name prefix, not just labels, because the per-role leftovers were
# made by hand and carry no labels at all. The env-label check is what keeps a
# production run (prefix "nabz-") from deleting staging's firewall, whose name
# "nabz-staging-fw" also starts with it.
for stale in $(api GET "/firewalls" \
    | jq -r --arg p "$SERVER_PREFIX" --arg keep "$FIREWALL_NAME" --arg e "$ENVIRONMENT" \
      '.firewalls[]
       | select(.name | startswith($p))
       | select(.name != $keep)
       | select((.labels.env // $e) == $e)
       | .id'); do
  echo "!! removing stale firewall id $stale (only $FIREWALL_NAME should exist for $ENVIRONMENT)"
  api DELETE "/firewalls/$stale" >/dev/null
done

# --- create (or find) each server -------------------------------------------
declare -A IP   # role|zone -> reachable ip (public when there is one), for NODES
declare -A SID  # role|zone -> server id, for network attachment
for entry in "${FLEET[@]}"; do
  IFS=: read -r suffix loc role zone <<<"$entry"
  # FLEET_ROLES filter: empty = the whole fleet.
  case ",${FLEET_ROLES:-},"  in *,,*) ;; *",$role,"*) ;; *) echo "· skipping $role (not in FLEET_ROLES)"; continue ;; esac
  name="${SERVER_PREFIX}${suffix}"

  existing="$(api GET "/servers?name=$(urlenc "$name")")"
  if [ "$(jq '.servers | length' <<<"$existing")" -gt 0 ]; then
    ip="$(jq -r '.servers[0].public_net.ipv4.ip // empty' <<<"$existing")"
    echo "· $name already exists ($loc)${ip:+ — $ip}"
  else
    require_egress
    echo "==> creating $name ($role${zone:+, zone=$zone}) in $loc [$SERVER_TYPE / $IMAGE]"
    body="$(jq -nc \
      --arg name "$name" --arg type "$SERVER_TYPE" --arg image "$IMAGE" \
      --arg loc "$loc" --arg key "$SSH_KEY_NAME" \
      --arg role "$role" --arg zone "$zone" \
      --argjson v4 "$PUBLIC_IPV4" --argjson v6 "$PUBLIC_IPV6" \
      --argjson pg "$PG_ID" --arg env "$ENVIRONMENT" \
      '{name:$name, server_type:$type, image:$image, location:$loc,
        ssh_keys:[$key], public_net:{enable_ipv4:$v4, enable_ipv6:$v6},
        placement_group:$pg,
        labels:({project:"nabz", env:$env, role:$role} + (if $zone=="" then {} else {zone:$zone} end))}')"
    ip="$(api POST "/servers" "$body" | jq -r '.server.public_net.ipv4.ip // empty')"
    echo "   created${ip:+ — $ip}${ip:+}"
    # Guarded: PRIVATE_NETWORK is not assigned until the private-network block
    # further down, and under `set -u` the bare form aborts here — on the only
    # path that reaches it (PUBLIC_IPV4=false), immediately after the first server
    # is created. That is precisely the half-provisioned fleet the preflights above
    # exist to prevent.
    [ -n "$ip" ] || echo "   (no public IP — reachable only from inside ${PRIVATE_NETWORK:-${SERVER_PREFIX}vnet})"
  fi
  IP["${role}|${zone}"]="$ip"
  SID["${role}|${zone}"]="$(jq -r '.servers[0].id // empty' <<<"$existing")"
  [ -z "${SID["${role}|${zone}"]}" ] && SID["${role}|${zone}"]="$(api GET "/servers?name=$(urlenc "$name")" | jq -r '.servers[0].id')"
  [ "$role" = "pocketbase" ] && PB_SERVER_ID="$(jq -r '.servers[0].id // empty' <<<"$existing")"
  [ "$role" = "pocketbase" ] && [ -z "${PB_SERVER_ID:-}" ] && PB_SERVER_ID="$(api GET "/servers?name=$(urlenc "$name")" | jq -r '.servers[0].id')"
done

# --- private network -----------------------------------------------------------
# Worker and evaluator reach PocketBase over this network and never touch the
# public internet (#338). PocketBase itself has no public inbound port at all —
# the web app comes in through a Cloudflare Tunnel instead. Private traffic is
# free and doesn't count against the traffic allowance.
#
# Attaching an EXISTING server needs no rebuild: Hetzner images configure the new
# interface via cloud-init / hc-utils and start a DHCP client on it.
PRIVATE_NETWORK="${PRIVATE_NETWORK:-${SERVER_PREFIX}vnet}"
PRIVATE_RANGE="${PRIVATE_RANGE:-10.0.0.0/16}"
net_json="$(api GET "/networks?name=$(urlenc "$PRIVATE_NETWORK")")"
if [ "$(jq '.networks | length' <<<"$net_json")" -gt 0 ]; then
  NET_ID="$(jq -r '.networks[0].id' <<<"$net_json")"
  PRIVATE_RANGE="$(jq -r '.networks[0].ip_range' <<<"$net_json")"
  echo "· network $PRIVATE_NETWORK exists ($PRIVATE_RANGE)"
else
  echo "==> creating private network $PRIVATE_NETWORK ($PRIVATE_RANGE)"
  NET_ID="$(api POST "/networks" "$(jq -nc --arg n "$PRIVATE_NETWORK" --arg r "$PRIVATE_RANGE" \
    '{name:$n, ip_range:$r, subnets:[{type:"cloud", network_zone:"eu-central", ip_range:$r}],
      labels:{project:"nabz"}}')" | jq -r '.network.id')"
fi

declare -A PRIVIP
for key in "${!SID[@]}"; do
  sid="${SID[$key]}"
  [ -n "$sid" ] || continue
  cur="$(api GET "/servers/$sid" | jq -r --argjson n "$NET_ID" '.server.private_net[] | select(.network==$n) | .ip')"
  if [ -z "$cur" ]; then
    echo "==> attaching ${key%%|*} to $PRIVATE_NETWORK"
    api POST "/servers/$sid/actions/attach_to_network" "$(jq -nc --argjson n "$NET_ID" '{network:$n}')" >/dev/null
    cur="$(api GET "/servers/$sid" | jq -r --argjson n "$NET_ID" '.server.private_net[] | select(.network==$n) | .ip')"
  fi
  PRIVIP["$key"]="$cur"
  echo "   ${key%%|*} private ip: $cur"
done

# --- PocketBase data volume --------------------------------------------------
# pb_data goes on a separate Volume, never the boot disk (#331). A Hetzner disk
# resize is ONE-WAY and permanently locks the server plan, so growing the boot
# disk would cost us the ability to change CPU/RAM ever again. A Volume grows on
# its own and detaches/reattaches, leaving the server type free to move.
#
# 20 GB is sized from the measured per-row costs in docs/pocketbase-storage.md:
# ~1,500 monitors at 60s across 2 zones under the 7-day checks retention. It is
# deliberately not a 5,000-monitor size — growing it is a live operation.
#
# Idempotent, same as the servers: looked up by name first. NEVER reformats an
# existing volume — `format` is only ever sent on creation.
# Defaulted out here, not inside the else-branch: the closing summary prints
# ${PB_VOLUME_SIZE}, and under `set -u` a FLEET_ROLES run that skips the
# pocketbase node crashed on it after all the work was already done.
PB_VOLUME_NAME="${PB_VOLUME_NAME:-${SERVER_PREFIX}pocketbase-data}"
PB_VOLUME_SIZE="${PB_VOLUME_SIZE:-20}"

if [ -z "${PB_SERVER_ID:-}" ]; then
  echo "· skipping the pb_data volume (no pocketbase node in this run)"
  vol_dev="(not provisioned)"
else
existing_vol="$(api GET "/volumes?name=$(urlenc "$PB_VOLUME_NAME")")"
if [ "$(jq '.volumes | length' <<<"$existing_vol")" -gt 0 ]; then
  vol_id="$(jq -r '.volumes[0].id' <<<"$existing_vol")"
  vol_size="$(jq -r '.volumes[0].size' <<<"$existing_vol")"
  vol_srv="$(jq -r '.volumes[0].server // empty' <<<"$existing_vol")"
  vol_dev="$(jq -r '.volumes[0].linux_device' <<<"$existing_vol")"
  echo "· volume $PB_VOLUME_NAME already exists (${vol_size}GB)"
  if [ -z "$vol_srv" ]; then
    echo "==> attaching $PB_VOLUME_NAME to ${SERVER_PREFIX}pocketbase"
    api POST "/volumes/$vol_id/actions/attach" \
      "$(jq -nc --argjson s "$PB_SERVER_ID" '{server:$s, automount:false}')" >/dev/null
    vol_dev="$(api GET "/volumes/$vol_id" | jq -r '.volume.linux_device')"
  elif [ "$vol_srv" != "$PB_SERVER_ID" ]; then
    die "volume $PB_VOLUME_NAME is attached to server $vol_srv, not ${SERVER_PREFIX}pocketbase ($PB_SERVER_ID). Detach it by hand — refusing to move a volume that holds data."
  fi
else
  echo "==> creating ${PB_VOLUME_SIZE}GB volume $PB_VOLUME_NAME in fsn1 (ext4) and attaching"
  # Create + attach + format in one call. `format` runs ONLY here, on a brand new
  # volume; automount stays off so setup-pocketbase.sh owns the mountpoint and
  # writes the fstab entry itself (with nofail).
  vol_json="$(api POST "/volumes" "$(jq -nc \
    --arg n "$PB_VOLUME_NAME" --argjson size "$PB_VOLUME_SIZE" --argjson s "$PB_SERVER_ID" \
    --arg env "$ENVIRONMENT" \
    '{name:$n, size:$size, server:$s, format:"ext4", automount:false,
      labels:{project:"nabz", role:"pocketbase", env:$env}}')")"
  vol_dev="$(jq -r '.volume.linux_device' <<<"$vol_json")"
  echo "   created — $vol_dev"
fi
fi

# --- emit the NODES block for the Bitwarden project --------------------------------
# NODES is what remote-deploy.sh SSHes to. With no public IP the private address is
# the only one there is, which also means the deploy must run from inside the
# network — a jump host, a VPN, or a self-hosted runner. A GitHub-hosted runner
# cannot reach 10.0.0.0/16.
addr() { # role|zone
  local k="$1"
  if [ -n "${IP[$k]:-}" ]; then printf '%s' "${IP[$k]}"; else printf '%s' "${PRIVIP[$k]:-<not provisioned>}"; fi
}
cat <<EOF

Provisioning done. Store in the environment's Bitwarden project (and set PB_URL to the
PocketBase server's address once DNS/TLS is in front of it):

NODES="
pocketbase $(addr 'pocketbase|')
evaluator $(addr 'evaluator|')
worker $(addr 'worker|eu-central') eu-central
"

PB_DATA_DEVICE=${vol_dev}
PB_URL=http://${PRIVIP[pocketbase|]:-<not provisioned>}:8090
PB_BIND_IP=${PRIVIP[pocketbase|]:-<not provisioned>}
PRIVATE_SUBNET=${PRIVATE_RANGE}

  ^ the ${PB_VOLUME_SIZE}GB volume holding pb_data. setup-pocketbase.sh mounts it
    and bind-mounts it into the container; leave it unset and PocketBase falls
    back to a local docker volume on the boot disk (which is what dev does).

Then: ./deploy/remote-deploy.sh prod
Tear down again with: ./deploy/hetzner/destroy.sh
EOF

if [ "$PUBLIC_IPV4" = false ]; then
  cat <<'EOF'

NOTE: these servers have no public IP, so the addresses above are private.
  - the deploy must run from inside the network (jump host, VPN, or a
    self-hosted runner); a GitHub-hosted runner cannot reach them.
  - they reach the internet only through the network's 0.0.0.0/0 route. If that
    gateway is down, every worker check fails at once — it is a single point of
    failure for the product, not just for management access.
EOF
fi
