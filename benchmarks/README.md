# benchmarks

Standalone measurement tools (their own Go modules — not part of the product
build, not in `go.work`). Build inside the tool's dir.

## pbbench — PocketBase capacity

Measures PocketBase write/read capacity under nabz's real access pattern, through
the HTTP API (worker service account for writes, a user for reads — same auth
path and API rules as prod). Nothing is written to SQLite directly. Results (and
the hardware caveat) live in [`docs/pocketbase-capacity.md`](../docs/pocketbase-capacity.md).

**Re-run this on the actual prod VM** — the committed numbers were taken on a
16‑core workstation and are an upper bound versus a 2‑vCPU cx22.

### Set up a target instance

Point it at any PocketBase with the nabz schema imported. Quick throwaway setup
(PB 0.28.4, the pinned prod release):

```bash
# 0. every command below uses $PB
PB=http://127.0.0.1:8090

# 1. run PB
./pocketbase serve --http=127.0.0.1:8090 --dir=./pb_data &
./pocketbase superuser upsert admin@bench.local password123456 --dir ./pb_data
TOKEN=$(curl -s $PB/api/collections/_superusers/auth-with-password \
  -H 'Content-Type: application/json' \
  -d '{"identity":"admin@bench.local","password":"password123456"}' | jq -r .token)

# 2. import schema (from repo root)
jq -nc --slurpfile c infrastructure/pb_schema.json '{deleteMissing:false,collections:$c[0]}' \
  | curl -s $PB/api/collections/import -X PUT -H "Authorization: $TOKEN" \
      -H 'Content-Type: application/json' --data-binary @-

# 3. enable the batch API — required by Test C, and OFF by default. The prod
#    bootstrap never enables it, so Test C cannot be run against a prod-shaped
#    instance without turning it on here first.
curl -s $PB/api/settings -X PATCH -H "Authorization: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"batch":{"enabled":true,"maxRequests":1000,"timeout":60}}'

# 4. create a worker service account, a user, and >=1 monitor owned by that user;
#    write the monitor ids to monitors.txt (one per line).
```

(The `worker` service account needs `role=worker,verified=true`; the user needs
`verified=true`; monitors reference the user via `user`.)

### Run

```bash
cd benchmarks/pbbench && go build .   # in the go.work workspace; no extra flags
./pbbench -pb http://127.0.0.1:8090 -monitors /path/to/monitors.txt \
  -wuser worker@bench.local -wpass workerpass123 \
  -ruser user@bench.local  -rpass userpass12345 \
  -seed 150000 -dur 8s
```

Flags: `-seed` rows to pre‑seed (spread over 24h, so read queries are realistic),
`-dur` per‑level duration, `-batch` batch size, `-runseed=false` to skip seeding.

It prints Test A (single‑insert write‑ceiling ramp), Test B (dashboard +
monitor‑detail reads under 60% write load), and Test C (batch‑size sweep). For the
limiter (Test A) and SQLite pragmas (Test D), sample the PB process CPU / disk
during the run and read `PRAGMA journal_mode` from the DB — see the docs.
