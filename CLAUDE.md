# Working in this repo

## Project

- **Purpose:** nabz is an uptime and status monitoring service — it probes
  endpoints from multiple zones, reaches consensus on whether something is
  really down, and alerts.
- **Stack:** three parts, not one.
  - **Web** — SvelteKit on **Cloudflare Workers** (`app/`, via
    `@sveltejs/adapter-cloudflare`). Config in `app/wrangler.toml`.
  - **Nodes** — Go services (`worker/`, `evaluator/`, shared `corelib/`;
    `go.work` also has `benchmarks/pbbench`), run as Docker containers on
    Hetzner VMs, deployed over SSH by `deploy/remote-deploy.sh`.
  - **Data** — self-hosted **PocketBase** on its own VM, reached over the
    private network by the nodes and through a Cloudflare Tunnel behind
    Cloudflare Access (`pb.nabz.sh`) from anywhere else.

Ops scripts (hardening, tunnel/Access, secrets, DB maintenance, upgrades, the VM
lab) are **not** in this repo: they are fetched from a pinned release of
[LytronHQ/ops](https://github.com/LytronHQ/ops) into `deploy/.ops/`. See
`docs/runbook.md` → "Where the ops scripts come from".

## Commands

The web app lives in `app/`, so its commands run from there.

| | |
|---|---|
| Install | `cd app && npm install` |
| Build | `cd app && npm run build` (Worker build: `npm run build:cf`) |
| Test (web) | `cd app && npx vitest run` — the **whole** suite; targeted runs miss stale component tests |
| Test (Go) | `go build ./... && go test ./...` in each of `worker/`, `corelib/`, `evaluator/` |
| Test (deploy scripts) | every `deploy/**/*_test.sh` (and the fixture `node --test`), exactly as `.github/workflows/ci.yml` lists them |
| Lint | `cd app && npm run lint` (prettier + eslint; CI runs it since #488) · types: `npm run check` |
| Local dev | `cd app && npm run dev` (vite, prints a localhost URL) |

`npx vitest run` from the **repo root** fails on `$lib` aliases and picks up
Playwright specs. Always run it from `app/`.

## Never disable commit signing

The rule is in the global `~/.claude/CLAUDE.md`. Here: signing **works
non-interactively on this machine** — verified, it does not prompt. An unsigned
commit cannot be fixed later, because `main` is protected against force-pushes
(deletion + non_fast_forward, no bypass actors). Ten unsigned commits landed on
`main` on 2026-08-30 — the override was added to dodge a passphrase prompt that
never actually happens.

## GitHub workflow

Issue → branch → PR → merge it yourself, and owner tasks as `needs-owner`
issues: see the global `~/.claude/CLAUDE.md`. Specific to this repo:

- **One PR at a time.** Never two open PRs, never a stack. The dev fleet holds
  exactly the one open PR, because that is what gets tested there.
- Put `Closes #N` on its own line in **both the commit message and the PR body**.
  In this repo the **commit** is what closes the issue on merge, and
  `closingIssuesReferences` is empty even when it works — so verify by reading
  the issue's state after merging, not by querying the link.
- **Commit before any deploy.** `remote-deploy.sh` ships *tracked* working-tree
  files, so "verified in dev" does not mean "committed". `git status` before
  finalizing a PR.

Owner-issue accuracy rules: see the global file. Lesson from here: an error
message's explanation of itself is a claim to test — `vmlab`'s io_uring error
blames `ulimit -l`; tested, that is false on any kernel ≥ 5.12.

## Visual testing

What to check and at which widths: see the global file. Here:

- Run `cd app && npm run dev` and open the **local** URL it prints.
- Playwright is already a dependency here (`npm run test:integration`).
- For Worker-specific behaviour (routing, the cron beat, `nodejs_compat`), build
  with `npm run build:cf` and serve that locally — `npm run dev` is vite, not the
  Worker runtime.
- The e2e stack (`e2e/`, Docker: PocketBase, worker, evaluator, fixture, built
  web) is the realistic local target. Start it with `e2e/setup.sh up` and run
  specs from `e2e/` with `npx playwright test`; the **whole** suite takes ~10 min.
  Users: `user@e2e.local` (ordinary) and `staff@e2e.local` (in `ADMIN_EMAILS`).
  The web is a built image, so rebuild it (`docker compose … up -d --build
  --no-deps web`) before testing an app change. Any direct `docker compose` on the
  e2e file needs `E2E_PB_VERSION=$(e2e/setup.sh pb-version)`: e2e builds
  production's PocketBase from `deploy/pocketbase/Dockerfile` at the version in
  `deploy/environments/production.vars` (#613). Set it to a newer version to try
  a PocketBase upgrade on e2e before production.
- 2026-10-11: `e2e/setup.sh` must mirror what `deploy/setup-pocketbase.sh` sets
  outside `pb_schema.json` (e.g. `users.listRule`). It did not, so `/admin/usage`
  showed "Total users 0" in e2e while production was fine.
- 2026-10-12: after a **web** deploy, read `/api/health` again **after 5+ minutes**
  and probe `POST /ping/<made-up-token>` (expect 404, never 403). The SvelteKit 3
  deploy looked healthy right after it and broke the cron liveness beat and
  customers' POST check-ins for 2h15m (#588): the e2e web is adapter-node, with no
  cron and no Worker wrapper, so nothing local could see it. `cfwrangler tail`
  needs `CLOUDFLARE_ACCOUNT_ID` set (two accounts), or it exits with no events.
- 2026-10-12: against a second stack (another `COMPOSE_PROJECT_NAME` and ports),
  export the project name, the ports *and* `E2E_PB` / `E2E_FIXTURE` for the whole
  run. Specs default to 8390/8788, and `sharding.spec.ts` runs `docker compose`
  itself: without the project name it built a whole extra `monitors-e2e` stack.
- 2026-10-11: format e2e specs with the app's config, from `app/`:
  `node_modules/.bin/prettier --config .prettierrc --write ../e2e/tests/<spec>`.
  Without `--config`, prettier finds no config above `e2e/` and rewrites the file
  in its defaults (double quotes, spaces); #557 merged `theme.spec.ts` that way.
- 2026-10-11: legacy alias tokens (`--ground`, `--ink`…) are `var(...)` values,
  which resolve where they are declared. Declared only on `:root`, they ignored
  the `.theme-dark` wrapper, so the "always dark" landing and changelog rendered
  light for 2½ months ([#528](https://github.com/LytronHQ/nabz-internal/issues/528)).
  Any new theme scope must re-declare them (`app.css`, the `:root, .theme-light,
  .theme-dark` block).
- 2026-10-19: vitest and e2e failed in a `git worktree` on a `node_modules`
  symlink artifact, not on the code. Run tests in the main checkout.

## PWA

This **is** a PWA: `app/static/manifest.webmanifest` is linked from
`app/src/app.html`, with `display: standalone` and `start_url: /dashboard`, so an
installed instance runs without browser chrome.

Since #493 it has a service worker (`app/src/service-worker/index.ts`), deliberately
narrow: it caches only the hashed build output (`/_app/immutable/…`) and lets every
page and API request go to the network. Updates come from SvelteKit's version poll
(`svelte.config.js`: `version.name` is `VERSION-commit`, polled every 60 s); when
a new build is live, `UpdateBanner` offers a reload. Verified end to end on the
e2e stack: a rebuild under an open page showed the banner in 23 s, and the reload
served the new build from a new cache.

- 2026-10-12: the e2e suite blocks service workers (`playwright.config.ts`).
  Playwright's headless shell segfaults closing a *traced* context with a live
  worker (3 of 40 runs), which surfaced as random "browser has been closed"
  failures. `pwa-update.spec.ts` allows them and runs in full Chromium.
- 2026-10-19: the installed desktop app has **no browser title bar** (#635):
  `display_override: ["window-controls-overlay"]` and an `.app-titlebar` strip
  under `@media (display-mode: window-controls-overlay)`. Headless Chrome cannot
  emulate that display mode (CDP `setEmulatedMedia` leaves it false), so a visual
  check applies the rules inside that media block to the page directly. In an
  installed window the page title drops "| nabz": the window adds the app name.
- 2026-10-19: the root `+layout.server.ts` reads `url.pathname` on purpose
  (#633). With no dependency SvelteKit reused its first `user` on every client
  navigation, so a session ended under an open tab (a password reset invalidates
  every token) showed /signin inside the signed-in shell.
- 2026-10-20: the installed app's window buttons take their colour from the
  `theme-color` meta, not from the page (#639). `watchThemeColor()`
  (`lib/utils/window-chrome.ts`) keeps the meta matched to the `.app-titlebar`
  colour when the theme changes; a new theme or accent must go through it.

## Push notifications

Since #602 there is a `push` alert channel (Web Push). The evaluator signs with
`VAPID_PRIVATE_KEY` and the web hands out `VAPID_PUBLIC_KEY`. Both are minted once
per environment by the `bootstrap-vapid` workflow into GitHub secrets. **Never
rotate them casually**: browsers bind every subscription to the public key, so a
new pair silently orphans every device.

- 2026-10-17: Playwright's `browser.newContext()` is **incognito**, and Chrome refuses
  the Push API there ("permission denied"). Use `chromium.launchPersistentContext`
  with `channel: 'chromium'`. That subscribes through Google's real push service,
  but Playwright's Chromium never receives the pushes, so test the worker's `push`
  handler with CDP `ServiceWorker.deliverPushMessage`.

## Sign in with GitHub and Google

Since #609 (code in #614; switched on per environment by its Bitwarden keys, #610; live and confirmed in production 2026-10-19). Users connect or disconnect providers on /account (#622), through `/auth/connect/<provider>`. PocketBase does the OAuth; `deploy/pb-oauth.sh` writes `users.oauth2`
from `OAUTH_GITHUB_*` / `OAUTH_GOOGLE_*` in Bitwarden on every deploy (a provider
without both halves stays off; none = OAuth off). Both OAuth apps are registered
with one callback, `https://nabz.sh/auth/callback`, so `/auth/start` on `www.`
moves to the apex first. Name and avatar come from `mappedFields`, on account
creation only.

- 2026-10-19: e2e ran PocketBase `latest` (0.40.4) while production ran 0.28.4
  ([#613](https://github.com/LytronHQ/nabz-internal/issues/613), now pinned to
  production's version). It showed up
  as an OAuth avatar that e2e never saved: PocketBase >= 0.30 refuses to download
  from private addresses, and the fixture is one. Check the PocketBase version
  before blaming the code.
- 2026-10-19: on PocketBase < 0.36.8, never read the users collection as a
  superuser: it blanks the OAuth secrets in memory until the next restart
  ([#619](https://github.com/LytronHQ/nabz-internal/issues/619)). Production is on
  0.40.5 ([#620](https://github.com/LytronHQ/nabz-internal/issues/620)).
- 2026-10-19: production had **never sent an account email** (verification, password
  reset, email change) since launch
  ([#627](https://github.com/LytronHQ/nabz-internal/issues/627)): PocketBase's SMTP,
  app URL and sender were never set (only the evaluator's `SMTP_*` were), so it fell
  back to a `sendmail` the container lacks, and the users templates still linked to
  PocketBase's admin UI. Nothing failed loudly: the request APIs answer 204 and the
  send happens later. Found only through 61k `Failed to send login alert` log lines.
  e2e now catches the mail (mailpit) and follows the links.
- 2026-10-19: Playwright's global setup and teardown bring the e2e stack up and
  **down** around every run. To keep a stack you started, run with
  `E2E_SKIP_SETUP=1` (use it as is) or `E2E_KEEP_STACK=1` (bring it up, leave it).

## Uptime and nabz's own failures

Since #598: a failed check counts against uptime unless it was nabz's fault. Right
after a failure the worker probes canaries (`WORKER_CANARY_URLS`, default Cloudflare
`/cdn-cgi/trace` + Google `generate_204`; any HTTP answer = reachable). If any is
unreachable the check is stored `inconclusive`: the evaluator abstains on it (like a
blocked one), rollups and the web's uptime filter it out (`COUNTED_CHECKS`), and the
checks log says "Not counted". A one-zone failure with healthy canaries still counts.
e2e plays the fault with the fixture's switchable `/canary`.

- 2026-10-19: six specs (accessible-names, admin ×3, graph-fit ×2) failed on every
  fresh stack, so the nightly e2e was red daily: they read data only other specs or
  older runs had left behind (#606). `e2e/seed.ts` now seeds it from global-setup.
  A new spec that reads shared data adds it there, or creates its own.
- 2026-10-19: the fixture test hung for good because another program on the laptop
  (`python3 -m http.server` on 8791) held its fixed port: `listen` failed and
  `start()` never resolved. It now takes free ports from the OS.

## Versioning & deploy

- `VERSION` at the repo root is the single version (currently **0.12.0**). The Go
  binaries carry it: it is injected via ldflags into `corelib/health.Version` and
  shows up in their logs and health output as `v0.12.0 (<commit>)`.
- The web carries the same version since #489: `vite.config.ts` compiles in
  `VERSION` and the commit (`GITHUB_SHA` in CI, the `GIT_COMMIT` build arg in
  Docker, else `git rev-parse`). `/api/health` returns `version` and `commit`, and
  the sidebar and landing footer show `v0.12.0 (abc1234)`. After a web deploy,
  check that `curl -s https://nabz.sh/api/health` reports the merged commit.
- **Deploys here are explicit and per-environment, not branch-triggered.**
  `deploy-web` and `deploy-nodes` are `workflow_dispatch` / `workflow_call` and
  take an environment as input; merging to `main` deploys nothing by itself. There
  is no `sandbox` branch — feature branches go to `main` through one PR at a time.
- The flow that replaces "collect in sandbox": every PR is deployed to the **dev**
  fleet, the owner tests there, and a production release is a deliberate run of
  `deploy-web` / `deploy-nodes` against the production environment.
- Bump `VERSION` as part of a production release (which needs the owner's
  explicit go-ahead).
- Claude tags version releases itself (`git tag` + push) as the last release step.
- PocketBase upgrades: bump `PB_VERSION` in `deploy/environments/*.vars`, run the
  e2e suite on it first, then `deploy/pocketbase/upgrade.sh` (#620). It rolls back
  if health fails; health is read on `PB_BIND_IP`, not 127.0.0.1, which once
  nearly rolled back a good upgrade.

## Environments

| | |
|---|---|
| Local dev | `cd app && npm run dev` · a local PocketBase in Docker |
| Dev fleet | local libvirt VMs — `deploy/vm/vmlab.sh create`, then `./deploy/remote-deploy.sh dev` (config in gitignored `deploy/dev.env`) |
| Staging | Worker `nabz-staging` on `*.workers.dev`, PocketBase at `pb-staging.nabz.sh`. The Worker **is live and is the real app**; its PocketBase was destroyed with the fleet, so `/api/health` returns `503 degraded`. Needs re-provisioning to be useful |
| Production | **Live since 2026-10-10.** Web: Worker `nabz` on `nabz.sh` + `www.nabz.sh`. PocketBase `nabz-pocketbase` (fsn1), reached privately by the nodes and through the tunnel + Access at `pb.nabz.sh`. Evaluator `nabz-evaluator` (fsn1). Two zones: `eu-central` (`nabz-worker-eu-central-1`, fsn1, private network) and `ap-southeast` (`nabz-worker-ap-southeast-1`, Singapore cpx02, a **public** worker through the tunnel, [#498](https://github.com/LytronHQ/nabz-internal/issues/498)). `deploy-web` uses `CF_WORKERS_API_TOKEN` (the Workers token), not `CF_API_TOKEN`, which has no Workers Routes ([#510](https://github.com/LytronHQ/nabz-internal/issues/510)). Nightly backup proven: `nabz-20261010-195604.zip` |

Deploy: run the `deploy-web` / `deploy-nodes` workflows against the environment,
or `./deploy/remote-deploy.sh <env>` from the laptop. Secrets come from Bitwarden
Secrets Manager for prod/staging, and from `deploy/<env>.env` for dev.

## Polling

- 2026-10-17: a local `until …; do sleep 20; done` loop calling `bws-env.sh
  production` ran for three hours because its condition never matched. It most
  likely got the Bitwarden machine account rate-limited, which failed a CI
  `infra-watch` run (#593). Every poll gets a deadline, and a background loop is
  stopped by PID when its turn ends.

## Data safety

- Local and dev use a **dev PocketBase**: the dev flow runs its own PocketBase
  in Docker; `PB_URL` must point at it.
- `deploy/*.env` and `deploy/.materialized/` are gitignored and hold real
  credentials. Never print their values.
- Tightening a `pb_schema.json` constraint is a **migration**: PocketBase
  re-validates the whole record on a partial PATCH, so violating rows become
  unwritable and alerting dies silently. Backfill *before* the import.
- **Never run a second SQLite process against a live PocketBase** — no `sqlite3`,
  no `pocketbase … --dir /pb_data` while the server runs (2026-10-10 production
  outage, [#520](https://github.com/LytronHQ/nabz-internal/issues/520)). PocketBase's
  backup closes its descriptors to `data.db-wal`/`-shm`, dropping the server's
  POSIX locks; the next external process then believes it is the last one and
  deletes the live WAL on exit. Use the API; do offline steps with the server
  stopped; run maintenance via `POST /api/crons/__pbDBOptimize__`
  ([#521](https://github.com/LytronHQ/nabz-internal/pull/521)). 2026-10-19: the
  hazard reproduces on 0.28.4 and **not** on 0.40.5 (`pb_live_db_test.sh` step 0b;
  PocketBase's backups changed in 0.38). The rule stands anyway.
