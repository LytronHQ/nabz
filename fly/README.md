# A worker on Fly.io

A zone is a set of workers, wherever they run. This is how one of them runs on
Fly.io instead of a Hetzner VM — zone `eu` as one worker in Germany and one in
the Netherlands, splitting the zone's monitors between them.

Everything about the sharding is in [`docs/scaling.md`](../docs/scaling.md); this
file is only what is different about the Fly half.

## What is different

| | Hetzner worker | Fly worker |
|---|---|---|
| Reaches PocketBase | private network, plain HTTP to the private IP | the public tunnel at `pb.nabz.sh` |
| Authenticates to Cloudflare Access | not in its path | its own service token (`CF_ACCESS_*`) |
| Deployed by | `ssh` + `docker compose` | the local `fly` CLI |
| Configured by | `/etc/monitors/worker.env` | `fly secrets` |

Everything else is identical, deliberately: the same image, the same worker
service account, the same `REGION_NAME` semantics, the same heartbeat.

## Deploying

There is no separate command. Add a line to `NODES` in the environment's env
file and the normal fleet deploy includes it:

```
worker 10.0.0.5 eu            # a VM in Germany
fly    nabz-worker-eu-fly eu ams   # a Fly machine in the Netherlands, same zone
```

Then:

```bash
./deploy/remote-deploy.sh production
```

The `fly` line is `fly <app-name> <zone> [region]`. Both workers are built from
the same commit in the same run, which is the point of deploying them together:
**two workers in one zone must never run different versions**, because they are
splitting one schedule between them.

The deploy sets the app's secrets (staged), builds from `worker/dockerfile` with
the repo root as the build context, releases, and pins the app to exactly one
machine.

## Why no service block in `fly.toml`

`auto_stop_machines` and `min_machines_running` belong to Fly's proxy: it stops a
machine when no requests arrive and starts one when they do. A worker receives no
requests — it makes outbound checks — so under a service definition it would look
idle and be stopped, which is the opposite of what a checker needs.

With no service at all the proxy never touches the machine and it runs
continuously. That is what "auto-stop off, minimum one machine" means here, and
`fly scale count 1` in the deploy holds the count.

Its liveness is visible where it actually matters: its row in
`worker_heartbeats`, and the zone's `zone_stats`.

## First-time setup

One-off, by an operator with the Cloudflare and Fly accounts — see the operator
steps in the pull request that added this, or:

1. `fly apps create <app-name>` and pick the region.
2. `fly auth login` on the machine that runs deploys.
3. From that same machine:

   ```bash
   ./deploy/cloudflare/fly-token.sh production
   ```

   It mints the Fly worker's own Access service token and writes
   `FLY_CF_ACCESS_CLIENT_ID` / `FLY_CF_ACCESS_CLIENT_SECRET` into the
   environment's Bitwarden project, where `remote-deploy.sh` materializes the env
   file from. Nothing to copy by hand.

### Why that is not a CI workflow

`infra-access` manages the **web** token and stores it in a GitHub environment
secret, which is write-only. The Fly token has to end up in **Bitwarden**
instead, and the CI machine account is read-only on that project **on purpose**:
write access there would let a compromised workflow rewrite PocketBase's
credentials and everything else in the environment. That is not a trade worth
making for a credential minted about once a year — so the machine that deploys
Fly is the machine that mints its token.

Both tokens live on the **same** Access policy. Access ORs policies, so a second
policy would be a second door, and `edge.sh access` refuses to leave one in place.

### Rotating or revoking

```bash
ROTATE_FLY_TOKEN=1 ./deploy/cloudflare/fly-token.sh production
```

Scoped to the Fly token: the web's credential is untouched, which is the whole
reason they are separate. Revoking is the same thing from the other end — delete
the token in Cloudflare and the Fly worker loses access while the web keeps
working.

If the Bitwarden write ever fails, the script **prints** the credential before
exiting non-zero. Cloudflare returns a service-token secret exactly once, so a
failed store must not swallow the only copy.
