# Hetzner Cloud provisioning

Creates the **production fleet** the launch checklist needs — three VPSes — using
plain bash against the Hetzner Cloud API. Same philosophy as everything else in
`deploy/`: no Terraform/Ansible, config from env, idempotent, re-runnable. This
step only *creates the servers*; the deploy itself is still
[`../remote-deploy.sh`](../remote-deploy.sh), which consumes the `NODES` block
`provision.sh` prints.

## The fleet

| Server | Location | Role | Zone code |
| --- | --- | --- | --- |
| `nabz-pocketbase` | Falkenstein (`fsn1`) | datastore + auth | — |
| `nabz-evaluator` | Falkenstein (`fsn1`) | incidents / rollups / alerts | — |
| `nabz-worker-eu-central-1` | Falkenstein (`fsn1`) | probe zone | `eu-central` |

**One probe zone for now — a known limitation, not an oversight.** A second
region is genuinely wanted: with a single zone, consensus
(`evaluator/consensus.go`) has nothing to outvote a bad network path with, so it
falls back to the N-consecutive-failures rule instead of cross-zone agreement,
and a local blip can look like a real outage.

It is one zone because the `cx` line we buy is **EU-only** (`fsn1`/`hel1`/`nbg1`)
and the US/APAC alternatives are ~3x the price — `cpx11` in Ashburn is €17.49/mo
against €5.49 for a `cx23`. A second zone goes in when Hetzner sells a
comparable plan in those locations; there is no interim US VM. `provision.sh`'s
preflight refuses loudly if `SERVER_TYPE` isn't sold where a fleet entry wants
it, so this can't be half-done by accident.

The zone code is `eu-central`, matching Hetzner's own `network_zone` for
Falkenstein/Nuremberg/Helsinki — the codes stay aligned with the provider's
labelling rather than inventing a parallel geography.

**Naming convention** (aligns with the zone-identity model): worker servers are
`nabz-worker-<zone_code>-<n>`, where `<n>` is a **per-zone** index starting at 1
and always present. Adding a second VM to a zone is `…-eu-central-2` and never
renames the first, because the hostname is ops identity (referenced in
Tailscale, logs, and heartbeat). The **zone code** emitted in `NODES` is the
bare code (`eu-central`) with **no index** — it is the queue key (`due:<zone>`) and
`checks.zone`, so it is load-bearing and immutable; the index must never leak
into it. Zone display names ("EU") live in the DB, not here.

## Prerequisites

- `curl` and `jq` on your laptop.
- A **Hetzner Cloud API token** with Read & Write (Project → Security → API
  tokens). Export it as `HCLOUD_TOKEN`.
- `SSH_PRIVATE_KEY` — the deploy key itself. Its fingerprint is matched against
  the keys registered in the project to decide which one to attach; if none
  matches, the public half is uploaded automatically. There is no key *name* to
  configure, so it cannot drift from the key you actually hold.

## Usage

```bash
# create (or find) all three servers, then print the NODES block
HCLOUD_TOKEN=…  SSH_PRIVATE_KEY="$(cat ~/.ssh/id_hetzner)"  ./deploy/hetzner/provision.sh

# tear it all down again
HCLOUD_TOKEN=…  ./deploy/hetzner/destroy.sh          # prompts
HCLOUD_TOKEN=…  ./deploy/hetzner/destroy.sh --yes     # no prompt
```

Servers **and the PocketBase data volume** are looked up by name before creation,
so re-running `provision.sh` is a no-op that just re-prints the `NODES` block —
safe to run repeatedly. An existing volume is never reformatted: `format` is only
ever sent on creation.

Overridable: `SERVER_TYPE` (default `cx23`), `IMAGE` (default `ubuntu-24.04`),
`SERVER_PREFIX` (default `nabz-`), `PB_VOLUME_SIZE` (default `20`, in GB),
`PB_VOLUME_NAME` (default `${SERVER_PREFIX}pocketbase-data`), `PUBLIC_IPV4` /
`PUBLIC_IPV6` (default `false`).

## Public IPs, and why

Servers get a public IPv4 and IPv6. The reason is **egress**, not access.

Hetzner gives a private-only server no route off the network and offers no
managed NAT, so going private-only means running a gateway server — and that
gateway is a single point of failure for **checking**, not merely for management:
if it dies, every worker stops probing at once. Public IPs give each node its own
independent path out, which for a monitoring product is the safer failure mode,
and it is cheaper than a gateway at roughly €0.50/mo per address.

Nothing is exposed by having one. [`harden.sh`](../harden.sh) runs `ufw` with SSH
as the only inbound port, key-only, plus `fail2ban` and unattended-upgrades;
PocketBase is reached through the Cloudflare Tunnel, which is an outbound
connection. A public IP is a way *out*, not a way in.

### Going private-only later

Set `PUBLIC_IPV4=false` / `PUBLIC_IPV6=false`. `provision.sh` refuses until the
network has a `0.0.0.0/0` route to a NAT gateway (`ALLOW_NO_EGRESS=1` overrides,
for when you are adding the gateway in the same session). Without one the nodes
cannot `apt-get`, cannot `docker pull`, cannot open the tunnel, and a worker
cannot probe a single URL.

`NODES` then carries private addresses, so the deploy must run from inside the
network — a jump host, a VPN, or a self-hosted runner. **A GitHub-hosted runner
cannot reach `10.0.0.0/16`, so `deploy-nodes` would stop working.**

## Placement group and firewall

Both are created per environment, before any server, and both are idempotent.

**Placement group** — one `spread` group (`${SERVER_PREFIX}spread`). Hetzner keeps
the members on separate physical hosts, so one host failing cannot take the whole
fleet. Servers join **at creation**: there is no API to move an existing server
into a group, which is why the group is created first.

Spread groups hold at most **10 servers in a single location**. The fleet is three
in `fsn1`, so that ceiling is far away — but it is a real one, and a second region
would need its own group.

**Firewall** — one per environment (`${SERVER_PREFIX}fw`), inbound **SSH only**
(22/tcp from `0.0.0.0/0` and `::/0`), attached by **label selector**
(`env=<environment>`) rather than to each server. A node created later carries the
label and is protected the moment it boots; per-server attachment fails open,
silently, at exactly the moment a new node joins. Everything else the fleet does is
outbound — the workers probe, the tunnel dials out — and Hetzner allows all egress
when no outbound rule is set.

`provision.sh` reconciles on every run: it rewrites the rules (so an extra port
opened in the console is closed again) and deletes any other firewall under the
prefix. Two firewalls on one server **union** their rules, so a stale one widens
the surface rather than being ignored. This is on-host `ufw` (via
[`../harden.sh`](../harden.sh)) *plus* a cloud firewall, not instead of it.

## The PocketBase data volume

`pb_data` goes on a **separate 20 GB Volume attached to the PocketBase server**,
never the boot disk. A Hetzner disk resize is **one-way and permanently locks the
server plan** — resize the boot disk once and that server can never change type
again, so CPU and RAM stop being independently scalable. A Volume grows on its
own and detaches/reattaches, leaving the server type free to move.

20 GB is sized from measured per-row costs — roughly 1,500 monitors at 60 s
across two zones under the 7-day `checks` retention. See
[`docs/pocketbase-storage.md`](../../docs/pocketbase-storage.md) for the table and
for why the request-log level is load-bearing to that number. Growing the volume
later is a live operation, which is the point of using one.

## After provisioning

1. Run from the `infra-hetzner` workflow and the printed values are stored as
   environment secrets automatically. By hand, put `NODES`, `PB_URL`,
   `PB_BIND_IP`, `PB_DATA_DEVICE` and `PRIVATE_SUBNET` into the environment's
   Bitwarden project. `PB_DATA_DEVICE` blank means PocketBase silently falls back
   to the boot disk.
2. `deploy-nodes` (or `./deploy/remote-deploy.sh <env>`) — installs Docker, ships the code, and brings
   each role up. Hardening (ufw, unattended-upgrades, fail2ban, key-only SSH)
   runs on-host via [`../harden.sh`](../harden.sh) as part of that deploy, so it
   is **not** duplicated here.

> Defence in depth: on-host `ufw` (via `harden.sh`) **and** the Hetzner Cloud
> firewall above. Both allow only inbound SSH; all monitoring traffic is outbound.
