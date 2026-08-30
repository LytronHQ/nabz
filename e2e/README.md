# End-to-end suite (#126)

A full-stack, black-box e2e suite that exercises the app against a **real running
stack** (PocketBase + worker + evaluator + Valkey + app) and **real-but-sandboxed
external services** — no mocks. It complements, and does not replace, the fast
unit tests.

This lands **incrementally**. This directory is built up in that order:

1. **Fixture target server** — _done_. A deterministic HTTP/TCP target the tests
   point monitors at, so check-driven features are exercised without the public
   internet. See [`fixture/`](fixture/).
2. **Ephemeral stack + Playwright harness** — _this PR_. A `docker compose` test
   stack (fresh per run, schema imported, seeded test user + service accounts)
   and the first journeys, which drive the **real** worker → evaluator → PocketBase
   pipeline through the API.
3. **Browser (UI) journeys** — Playwright page flows (sign in → create a monitor
   → drive an incident down→up, escalation, maintenance, tags/search). _next._
4. **Real sandboxed channels, one at a time** — Telegram / email / Slack /
   Discord / webhook / PagerDuty, asserting *actual* delivery. Each
   skips with a clear message when its credential isn't configured, so the suite
   degrades gracefully. Credentials come from CI secrets / a gitignored env file
   (`.env.local`), never committed. _later._

## The stack

`docker-compose.e2e.yml` brings up the whole system on one network — PocketBase,
Valkey, worker, evaluator, web, and the fixture — so a monitor pointed at
`http://fixture:8080` is checked by the **real** worker and its status is set by
the **real** evaluator. `setup.sh` bootstraps PocketBase (superuser, schema
import, a seeded dashboard user + worker/evaluator service accounts). All creds
here are throwaway LOCAL test values with in-file defaults — nothing sensitive.

### Running the suite

```bash
cd e2e
npm ci
npx playwright test          # global-setup builds+starts the stack, runs, tears down

# Iterating with the stack already up (faster):
npm run stack:up             # bring the stack up + seed (leaves it running)
E2E_SKIP_SETUP=1 E2E_KEEP_STACK=1 npx playwright test
npm run stack:down           # when done
```

Ports (overridable): web `4390`, PocketBase `8390`. The pipeline is async (the
worker seeds/checks, the evaluator ticks), so the journeys **poll** with generous
timeouts instead of sleeping.

Runs in CI as a **separate, on-demand + nightly** workflow
([`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml)) — never per-PR (slow,
real stack). The fast unit tests stay the per-PR gate.

## Fixture target server

A zero-dependency Node stdlib server (`fixture/server.mjs`). Behaviour is encoded
in the request **path**, so every response is a pure function of the URL — no
shared state, deterministic under concurrency.

| Route | Behaviour |
|-------|-----------|
| `GET /` , `GET /health` | `200` (liveness) |
| `/status/:code` | returns that status; `429`/`503` add `Retry-After` (`?retryAfter=N`) |
| `/slow?ms=N` | `200` after N ms — latency thresholds / timeouts |
| `/redirect?n=N&to=URL` | N-hop `302` chain, then `200` (or `302→to`) |
| `/body?text=STR&status=C` | body `STR` at status `C` — keyword/body assertions |
| `/echo` | JSON of the received method/headers/body — assert what the app sent |
| TCP port (default `9090`) | always **open**, for `port` monitors (a **closed** port is any unused one) |

### Run it

```bash
cd e2e/fixture
npm test          # node --test — drives every route
npm start         # run standalone: HTTP :8080, TCP :9090 (PORT / TCP_PORT to override)
```

In the stack (step 2) it runs as a container reachable at `http://fixture:8080`
from the worker.

### Not yet covered (later increments)

- Controllable TLS certs (soon-to-expire / expired) for SSL-expiry warnings.
- A webhook receiver that records payloads (for channel-delivery assertions).
