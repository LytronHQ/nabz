# Deploying monitors

Two kinds of node, plus the UI:

| Node | What runs | How many | Where |
|---|---|---|---|
| **Worker** | Valkey + worker (`deploy/worker.yml`) | one per zone (1–3 workers each) | a VPS per region (e.g. Hetzner) |
| **Evaluator** | evaluator (`deploy/central.yml`) | exactly **one** | a central host, **not** a zone VM |
| **UI** | SvelteKit | — | Cloudflare Workers (prod/staging); a Node VM on dev |

Everything talks to your hosted **PocketBase** (`PB_URL`). Nothing talks between nodes directly — the worker uses its own local Valkey, and both apps read/write PocketBase over HTTPS.

## How deploys happen

- **Prod and staging** — GitHub Actions. Secrets come from Bitwarden; see **Secrets** below and the Deploy section of the [root README](../README.md).
- **Dev** — `./deploy/remote-deploy.sh dev` from your laptop, against libvirt VMs, reading `deploy/dev.env`.
- **On the box** — `curl … | sudo bash` a per-node `setup-*.sh` directly, for a one-off. That is what the other two do for you over SSH.

All three end in the same place: the per-role compose files (`worker.yml`, `central.yml`, `pocketbase.yml`, `web.yml`) are the single source of truth for what runs.

**Hardening.** On first deploy each node is hardened once (`deploy/harden.sh`, marked by `/etc/monitors/.hardened`): **ufw** (allow SSH only — the app publishes no other ports), **unattended-upgrades** (auto security patches), **fail2ban**, and **key-only SSH** (password auth off). The SSH change is applied via a drop-in that's validated with `sshd -t` and *reloaded* (never dropping your session), and it disables passwords only — so **deploy with an SSH key** (as these guides do) and you won't be locked out. Re-run hardening any time with `sudo bash /opt/monitors/deploy/harden.sh`.

---

## Local development (Virtual Machine Manager / libvirt)

1. **VMs:** create 1–2 Ubuntu VMs with [`deploy/vm/create-vm.virt-manager.sh`](vm/) — a minimal cloud image on the libvirt NAT network (`192.168.122.0/24`), your Launchpad SSH keys imported, ready to deploy onto:
   ```bash
   deploy/vm/create-vm.virt-manager.sh --name mon-eu --user dev --cpu 2 --ram 2048 --disk 20 \
     --image https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img
   ```
   It prints the VM's IP. Set `SSH_USER` to that `--user` in `dev.env` (the login user has passwordless sudo).
2. **A dev PocketBase — not production.** Run one locally so tests don't pollute prod:
   ```bash
   docker run -d -p 8090:8090 ghcr.io/muchobien/pocketbase
   docker exec -it <id> /usr/local/bin/pocketbase superuser upsert you@dev.local devpassword --dir /pb_data
   ```
   Import `infrastructure/pb_schema.json`, then create the two `service_accounts` records. Use a `PB_URL` the **VMs** can reach — your host's bridge IP (e.g. `http://192.168.122.1:8090`), not `127.0.0.1`.
3. **Config + deploy:**
   ```bash
   cp deploy/dev.env.example deploy/dev.env      # fill SSH_KEY, PB_URL, creds, NODES (VM IPs + zones)
   ./deploy/remote-deploy.sh dev
   ```
4. **Watch:** `ssh root@<vm> 'docker compose --env-file /etc/monitors/worker.env -f /opt/monitors/deploy/worker.yml logs -f'`.

## Secrets

**Bitwarden Secrets Manager holds every secret value.** This repo holds structure
only — no plaintext secret is ever written to a tracked file, and the local
`deploy/<env>.env` fill-in-by-hand flow is gone for prod and staging.

- Two BWS projects, `nabz-prod` and `nabz-staging`, each keyed by the exact env
  var name.
- Two machine accounts, each able to read only its own project. Their access
  tokens live in a password manager and reach the tooling as `BWS_ACCESS_TOKEN`.
- Non-secret config — hostnames, usernames, the project ids themselves — goes in
  `deploy/environments/<env>.vars`. Copy
  [`environments/example.vars`](environments/example.vars) to `<env>.vars` and
  fill it in; every key is commented there. Project ids are ids, not credentials.

Prerequisites: `bws`, `jq`, `gh`.

```bash
read -rs BWS_ACCESS_TOKEN && export BWS_ACCESS_TOKEN   # not in shell history

./deploy/bws-env.sh production                  # materialize -> prints the file path
./deploy/github/setup-env.sh production         # sync BWS -> GitHub Actions secrets
```

`bws-env.sh` merges the committed non-secret vars with the project's secrets and
writes `deploy/.materialized/<env>.env` — gitignored, mode 600, and **disposable**:
delete it whenever, it is rebuilt on demand. `--stdout` skips the file entirely
and prints `KEY='value'` lines for `eval`.

`remote-deploy.sh` materializes automatically when there is no local
`deploy/<env>.env`, so the fleet deploy needs no extra step. A local file still
wins where one exists — that is the libvirt dev flow, which has no BWS project.

## Production and staging

**Automated — see the Deploy section of the [root README](../README.md).** A cold
start is the `provision-all` workflow against an environment; after that,
`deploy-nodes` and `deploy-web`. Every credential is an environment secret and
each workflow writes its outputs back, so nothing is copied by hand.

The scripts the workflows run are the same ones you can run locally with an env
file, which is what `deploy/dev.env` is for:

| Script | Does |
|---|---|
| `hetzner/provision.sh` | Servers, `pb_data` volume, private network |
| `cloudflare/tunnel.sh` | Tunnel, ingress, DNS |
| `cloudflare/access.sh` | Access application, policy, service token |
| `remote-deploy.sh <env>` | The fleet, over SSH |
| `hetzner/destroy.sh` | Tears it down, volume included |

Two properties of `remote-deploy.sh` worth knowing before reading it: PocketBase
is deployed **first** whatever order `NODES` lists (its setup seeds the schema and
the service accounts everything else logs in with), and a readiness gate — run
**from a node**, since `PB_URL` is a private address — aborts before worker or
evaluator if those accounts cannot authenticate. It also ships the tracked
**working tree**, so from a laptop, commit first.

Verification steps are Phase 4 of
your own launch checklist.

> `deploy/dev.env` (libvirt only) is gitignored. Prod and staging hold no local
> secrets file at all — see **Secrets** above.

---

**Compose is the single source of truth for what runs.** The setup scripts only *bootstrap* a bare host (Docker, code, env file), then hand off to `docker compose -f deploy/<role>.yml up -d`. Adding a zone = provision a VM → fill the env file → `compose up`.

## Service accounts (scoped, least-privilege)

The apps authenticate to PocketBase as **scoped service accounts** — not superusers — so a leaked worker token can't wipe the DB. Setup (once):

1. Import `infrastructure/pb_schema.json` (PB Admin → *Settings → Import collections*, **"Delete missing collections" unchecked**). This adds the `service_accounts` auth collection and the role-gated API rules. Editing that file later? Tightening a field constraint is a **data migration** — see [docs/schema-constraints.md](../docs/schema-constraints.md).
2. In PB Admin → **`service_accounts`**, create two records (set `verified = true`):
   - one with **`role = worker`** (e.g. `worker@svc.yourdomain`)
   - one with **`role = evaluator`** (e.g. `evaluator@svc.yourdomain`)
3. Put each account's creds in the matching env file, with `PB_AUTH_COLLECTION=service_accounts`.

What each role can do: **worker** → read `monitors`, create `checks`, r/w `zone_stats`, stamp `monitors`. **evaluator** → read `checks`/`monitors`/`alert_channels`/`zone_stats`, write `status`/`incidents`/`rollups`, delete old `checks`. Neither can delete `monitors` or touch `users`/`_superusers`/schema. (`PB_AUTH_COLLECTION` **must** be set — normally `service_accounts`. An empty value is rejected at startup rather than falling back to `_superusers`, so a node never runs privileged by accident, #70.)

## Worker node (one per zone)

On a fresh Ubuntu/Debian VPS, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/LytronHQ/nabz/main/deploy/setup-worker.sh | sudo bash
# first run creates /etc/monitors/worker.env and stops
sudo nano /etc/monitors/worker.env      # PB_URL, PB_AUTH_COLLECTION, worker account creds, REGION_NAME
curl -fsSL https://raw.githubusercontent.com/LytronHQ/nabz/main/deploy/setup-worker.sh | sudo bash
docker compose --env-file /etc/monitors/worker.env -f /opt/monitors/deploy/worker.yml logs -f
```

**Multiple zones:** run it on each VPS with a different `REGION_NAME` (`eu`, `us`, …). Inline for one run: `REGION_NAME=us curl … | sudo bash`.

### The anonymous "free" zone (#265)

The "try it without signing up" feature runs anonymous monitors in a **dedicated, isolated zone** so untrusted, unauthenticated traffic never touches the real `eu`/`us` workers. It's an ordinary worker node with one reserved zone name — **`free`** — which flips the worker into anon mode:

- it runs the **`anon_monitors`** collection instead of `monitors` (its own `due:free` queue + its own Valkey),
- it enforces the **SSRF guard** (`BLOCK_PRIVATE_TARGETS=true`, set automatically for `free`), since it checks arbitrary user URLs,
- it reaps anon monitors past the **1-hour TTL**,
- and it publishes **no** `zone_stats`, so it stays out of the public `/api/health`.

**Provision it** exactly like any worker node — one small VPS, SSH key at creation, no inbound ports but SSH:

- **Laptop deploy:** add one line to `NODES` — `worker <free-vps-ip> free` — and re-run `./deploy/remote-deploy.sh <env>`, which sets `REGION_NAME=free` + `BLOCK_PRIVATE_TARGETS=true` on that host and composes it up.
- **On-box:** `REGION_NAME=free curl -fsSL …/setup-worker.sh | sudo bash`, and set `BLOCK_PRIVATE_TARGETS=true` in `/etc/monitors/worker.env`.

Uses the **same** `role=worker` service account as the other zones (the `anon_monitors` rules allow any service account). `free` is a **reserved** zone name — don't assign real monitors to it.

Verify: create a trial monitor via the landing "try it" flow → `docker compose --env-file /etc/monitors/worker.env -f /opt/monitors/deploy/worker.yml logs -f` shows `[anon <id>] up=… code=…`, and the row flips `pending → up/down`. Leave it an hour → the cleanup log reports it deleted.

## Evaluator (one, central)

```bash
curl -fsSL https://raw.githubusercontent.com/LytronHQ/nabz/main/deploy/setup-evaluator.sh | sudo bash
sudo nano /etc/monitors/evaluator.env   # PB creds; optional SMTP + OPS_WEBHOOK_URL
curl -fsSL https://raw.githubusercontent.com/LytronHQ/nabz/main/deploy/setup-evaluator.sh | sudo bash
docker compose --env-file /etc/monitors/evaluator.env -f /opt/monitors/deploy/central.yml logs -f
```

Without the evaluator you still get raw **checks/logs** from the worker; the evaluator sets monitor **status** (consensus), opens/closes **incidents**, sends **alerts**, and builds **rollups**.

## UI

Prod and staging run on Cloudflare Workers — see [`cloudflare/`](cloudflare/) and
the `deploy-web` workflow. The dev VM runs the Node adapter from
[`web.yml`](web.yml), configured by `remote-deploy.sh` from `dev.env`.

## Branding — PocketBase app name (operator step)

The product is **nabz**. The app code says so everywhere, but two things live
**outside** the committed config and must be set on the live instance, or they keep
showing the old name:

- **PocketBase `APP_NAME`.** The verification / password-reset email templates interpolate
  `{APP_NAME}` ("Thank you for joining us at {APP_NAME}", "The {APP_NAME} team"). This is a
  PocketBase **Settings → Application → Application name** field, **not** part of
  `pb_schema.json`, so a fresh instance defaults to the old value. Set it to `nabz` in the
  PB admin UI after standing up the instance.
- **`SMTP_FROM` display name.** Set the from-address display name to `nabz` where your
  provider allows it (the code sends a bare address today), so alert emails read
  `nabz <alerts@…>`.

## Health endpoints (self-monitoring)

Each worker and the evaluator serve a small HTTP health surface (default port
`8080`, published as `HEALTH_PORT`; set `HEALTH_ADDR=off` to disable). It has two
tiers — a **public** one that reveals nothing sensitive, and a **token-gated
debug** one for figuring out *what* is broken.

- `GET /health` — this node. Returns `200 {"status":"ok"}` or
  `503 {"status":"degraded"}`. Nothing else.
- `GET /health/all` — **evaluator only**, the fleet aggregate. Adds at most the
  **names** of unhealthy zones: `{"status":"degraded","unhealthy":["worker-eu"]}`.

The public tier is designed to be safe to expose: it never returns connection
targets, hosts, ports, IPs, credentials, or raw driver errors. Confirm that:

```bash
# Public — only ok/degraded (+ unhealthy names on the aggregate). No internals.
curl -s http://<evaluator-host>:8080/health
curl -s http://<evaluator-host>:8080/health/all
```

**Debug detail** rides behind a bearer token. Set `HEALTH_DEBUG_TOKEN` in the env
file (shared across nodes); a blank token keeps the debug tier off. Then:

```bash
curl -s -H "Authorization: Bearer $HEALTH_DEBUG_TOKEN" \
  http://<host>:8080/health
# {"status":"degraded","node":"worker-eu",
#  "build":{"version":"0.5.0","commit":"c40711b"},
#  "items":[
#   {"name":"valkey","status":"unreachable","cause":"did not respond to a health probe"},
#   {"name":"pocketbase","status":"ok"}]}

curl -s -H "Authorization: Bearer $HEALTH_DEBUG_TOKEN" \
  http://<evaluator-host>:8080/health/all
# items carry a generic label + staleness, e.g. {"name":"worker-eu","status":"stale","stale_for":"4m2s"}
```

The debug tier still reports only **what** is wrong (which node, which dependency
label, since when) — never **with what**. A missing or wrong token silently
returns the public body (no 401, no hint that a token exists), and the compare is
constant-time. The Docker healthchecks keep using the `--health-check` CLI probe,
independent of this HTTP surface.

### Public fleet health on the web — `GET /api/health`

The worker/evaluator endpoints above live on internal `:8080` addresses. For a
**single internet-facing** status URL (for an external uptime monitor or a status
page), the **web** app serves `GET /api/health`. It aggregates from **PocketBase
only** — worker-zone heartbeats + the evaluator's self-heartbeat + PB
reachability — so it works even when the web runs on Workers and can't reach the
private nodes.

Same two tiers. Public (no auth) is safe to expose:

```bash
curl -s https://<your-web-host>/api/health
# {"status":"ok"}   (or {"status":"degraded","unhealthy":["evaluator"]} — names only)
```

Debug detail rides behind `HEALTH_DEBUG_TOKEN` (set in the web env):

```bash
curl -s -H "Authorization: Bearer $HEALTH_DEBUG_TOKEN" https://<your-web-host>/api/health
# {"status":"degraded","items":[
#   {"name":"pocketbase","status":"ok"},
#   {"name":"evaluator","status":"stale","cause":"no recent heartbeat within the staleness window",
#    "stale_for":"4m2s","last_seen":"2026-08-01 17:59:41.000Z"},
#   {"name":"eu","status":"ok","last_seen":"2026-08-01 18:03:38.000Z"}]}
```

Each heartbeat item carries both `stale_for` (relative — how long silent, recomputed each request) and `last_seen` (the absolute heartbeat timestamp, so you can pin exactly when a node went silent). PocketBase has no heartbeat, so no `last_seen`.

A node counts as **stale** after `HEALTH_STALE_SECONDS` (default 90) without a
heartbeat. This is how a **dead evaluator** is detected — nothing else can (the
dead-man switch runs *inside* the evaluator). To see it: stop the evaluator
(`docker compose --env-file /etc/monitors/evaluator.env -f deploy/central.yml stop evaluator`), wait past the staleness
window, and `/api/health` reports `degraded` with `evaluator` stale.

## First smoke test

1. Add a monitor in the UI: website, `https://example.com`, interval `30` (the minimum, #319), enabled, zones left empty.
2. `docker compose --env-file /etc/monitors/worker.env -f /opt/monitors/deploy/worker.yml logs -f` → `[<id>] up=true code=200 …`.
3. UI → the monitor's detail page shows the response-time chart + recent checks. With the evaluator running, its status flips from `pending` to up/down.
