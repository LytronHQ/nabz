# Cloudflare Workers — the nabz web app

Production hosting for the SvelteKit app. Built with
[`@sveltejs/adapter-cloudflare`](https://svelte.dev/docs/kit/adapter-cloudflare)
and deployed to **Cloudflare Workers with static assets**. Build config is in
version control ([`app/wrangler.toml`](../../app/wrangler.toml)), not a hosting UI.

## Deploy

`deploy-web` in GitHub Actions: build, `wrangler deploy`, push the secrets with
`wrangler secret bulk`, then assert an unauthenticated request to PocketBase is
refused.

`[env.staging]` in `wrangler.toml` is a separate Worker on `workers.dev` with its
own PocketBase — deployed by setting the environment's `WRANGLER_ENV=staging`.

## We do NOT use Workers Builds (the git integration)

**Deliberate, not an oversight — please don't reconnect it.** Deploys are the CLI
flow above, run by a human who can see the output.

The reason is debuggability. The `deploy-web` workflow prints its build output in
a log you can read from `gh`, next to the code that changed. Workers Builds puts
it behind the Cloudflare dashboard, where it is reachable only by whoever has an
account and knows to go looking. That is not hypothetical: the integration was
connected once and its red check cost **two rounds of investigation** on every PR
it touched, because the failure reason existed only in the UI — GitHub's check API
exposes nothing but a dashboard link, so the log could not be read from `gh`, from
CI, or from a local checkout — all of that for a one-line misconfiguration.
Keeping build config in version control (`wrangler.toml`) is a real benefit too,
but it is the secondary one.

For the record, the two ways it broke — both silent from outside the dashboard:

**1. The root directory defaulted to the repo root.** `package.json` lives in
`app/`, so `npm run build` died with
`ENOENT: /opt/buildhome/repo/package.json` before installing a single
dependency. Zero-second failures on every PR, including branches carrying no
Cloudflare config at all — which made it look like a dependency problem when it
was nothing of the kind.

**2. The build command had no `ADAPTER`.** The default `npm run build` leaves
`ADAPTER` unset, and [`app/svelte.config.js`](../../app/svelte.config.js) falls
through to `adapter-auto`. That build **succeeds** and emits no `_worker.js`, so
`wrangler.toml`'s `main` points at nothing and the breakage surfaces at deploy
time instead of build time.

If it is ever reconnected on purpose, it needs a root directory of `app`, a build
command of `ADAPTER=cloudflare npm run build`, and a deploy command of
`npx wrangler deploy` — and the debuggability cost above still applies.

## Config split

| Where | What |
|-------|------|
| `app/wrangler.toml` `[vars]` | **non-secret** runtime env: `PB_URL`, `WEB_PB_COLLECTION`, `HEALTH_STALE_SECONDS` |
| Worker secrets (pushed by `deploy-web`) | `PKCE_FLOW_ENCRYPTION_KEY`, `WEB_PB_USERNAME`, `WEB_PB_PASSWORD`, `HEALTH_DEBUG_TOKEN`, `ADMIN_EMAILS`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` |

Values come from Bitwarden Secrets Manager via the environment's GitHub secrets;
rotating one means updating BWS, running `setup-env.sh`, then `deploy-web`.

The app reads everything through `$env/dynamic/private`, which adapter-cloudflare
populates from the Worker's env (both `[vars]` and secrets), so no code cares
which bucket a value came from.

## Reaching PocketBase — Tunnel + Access (#338)

PocketBase has no public inbound port. Worker and evaluator reach it privately;
this app runs on Cloudflare Workers, which can't route to a private IP, so it
comes in via a Cloudflare Tunnel behind Access. Avatars are proxied through
`/api/avatar` so no Access carve-out is needed.

### Setup

`infra-tunnel` and `infra-access` create all of it — tunnel, ingress, DNS, Access
application, Service Auth policy, service token — and store the results as
environment secrets. Nothing here is a dashboard procedure any more; the scripts
they run are [`tunnel.sh`](tunnel.sh) and [`access.sh`](access.sh), both
idempotent and runnable by hand with the same env vars.

Two things those scripts encode that are easy to get wrong by hand: the tunnel
ingress must be **HTTP** to the node's **private** IP (the hop is inside the
private network and PocketBase serves plain HTTP), and the Access policy must be
`non_identity` — an `allow` policy would also admit browser identity flows,
which is a second door. `access.sh` refuses to proceed if any other policy exists
on the application, because Access ORs them.

Rotating the service token is `infra-access` with `rotate_token: true`, then
`deploy-web`. Cloudflare only returns a token's secret at creation, so a plain
re-run cannot reprint it.

### Verify (after the first deploy)

```bash
curl -si https://pb.nabz.sh/api/health | head -1          # MUST be 302/403
curl -si -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
        -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
        https://pb.nabz.sh/api/health | head -1           # PocketBase answers
```

If the first returns PocketBase JSON, `global_fetch_strictly_public` isn't in
effect and every Worker request is bypassing Access.

| Symptom | Cause |
|---|---|
| Tunnel inactive after deploy | `TUNNEL_TOKEN` missing from the environment's Bitwarden project |
| 502 | Hostname URL must be `http://` + the private IP |
| Web app 403s | `CF_ACCESS_*` not pushed, or policy isn't Service Auth |

## No `ORIGIN`

The Node adapter needed `ORIGIN` for SvelteKit's CSRF origin check behind a
proxy. On Workers the origin is derived from the incoming request, so **`ORIGIN`
is dropped** — CSRF (POST forms, `/api/anon`) works without it. (The `dev`-VM
Node path in `deploy/web.yml` still sets `ORIGIN`; that's unchanged.)

## Custom domains

`wrangler.toml` binds **`nabz.sh`** and **`www.nabz.sh`** as Cloudflare custom
domains (the zone must be in the same account; TLS is managed by Cloudflare).

## Watch out (from the launch checklist's dev-vs-prod risk section)

`remote-deploy.sh` auto-fills `WEB_PB_USERNAME`/`WEB_PB_PASSWORD` for the *dev*
`web` VM, but prod's web is Cloudflare, which `remote-deploy` never touches. If
those secrets are missing, the public `/ping/{token}` heartbeat endpoint silently
drops check-ins (the #150 shape). `deploy-web` pushes them — just make sure they
are in the BWS project.
