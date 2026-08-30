# Changing constraints in `pb_schema.json`

**Tightening a `min`, `max`, `required`, or pattern on an existing field is a data
migration, not a schema edit.** If you take one thing from this page: a constraint that
only *new* data satisfies will silently break writes to *existing* rows.

This is not a general SQL truth — it is specific to how PocketBase saves records, and it
is unintuitive enough that it has already cost us one near-miss (#319/#320).

## Why

PocketBase re-validates the **entire record** on every save, including a partial `PATCH`
that never mentions the field you changed. The update path loads the stored record,
applies only the submitted keys on top, and then runs every field's validator against the
merged result.

So after you tighten a constraint:

- an existing row that violates it is **not** rejected at import time — the import
  succeeds and returns `204`;
- but that row is now **unwritable**. Every subsequent `PATCH` fails, no matter which
  field it touches.

There is no warning at import time and nothing in the schema file to hint at it.

## What that looks like in this system

Concretely, when `monitors.interval` went from `min: 5` to `min: 30` with existing rows
storing `10`:

```
PATCH /api/collections/monitors/records/<id>  {"status":"down"}
→ 400 {"data":{"interval":{"code":"validation_min_number_constraint",
                           "message":"Must be larger than 30.000000."}}}
```

The `status` write has nothing to do with `interval`, and it fails anyway. The damage
follows the writes:

| Write | Caller | Consequence |
|---|---|---|
| `{"status": …}` | evaluator, `UpdateMonitorStatus` | The status never changes, so the evaluator re-enters the same branch every tick — **no incident ever opens or resolves for that monitor**, forever. It is a `return err` before `reconcileIncident`, so the alerting path is never reached. |
| `{"last_checked": …}` | worker, after every probe | Logged and ignored — probes keep running while the timestamp freezes. Quieter, and therefore worse. |
| `/ping/{token}` | heartbeat check-ins | Returns HTTP 500 to the caller's cron on every ping. |

The only visible signal is a per-tick `evaluation failed` log line. Health checks stay
green. Recovery is manual and per-row: a human has to edit each monitor.

## What to do instead

Before tightening anything, ask: **can a stored row violate this?**

1. **Normalise the data first, then tighten the constraint.** In that order.
   `deploy/setup-pocketbase.sh` runs its backfill immediately *before* the schema import
   for exactly this reason — see `backfill_min_interval()` there for the shape to copy.
   Remember [remote-deploy.sh re-runs the import on every deploy](../deploy/README.md), so the
   backfill has to be idempotent and live in the same script, not in a one-off you ran by
   hand once.
2. **Or don't tighten the schema at all.** Enforce the new rule in the app/API layer,
   which validates *submitted* values rather than re-validating *stored* ones. This is the
   right answer when old data is legitimately allowed to stay as it is.
3. **Keep every layer's floor identical.** The schema, the Zod validator in
   `app/src/lib/models/monitor.ts`, the form input's `min`, and any Go constant
   (`corelib/models`) must agree. If the app's floor is *looser* than the schema's, the API
   accepts a value PocketBase then rejects, and the user sees an opaque 500 instead of a
   field error.
4. **Check the fixtures.** `e2e/` seeds rows straight through the PocketBase REST API
   against this same schema file, so a tightened constraint breaks the e2e suite before it
   breaks production — but only if you run it, since e2e is not part of PR CI.

## Loosening is safe

Widening a constraint — lowering a `min`, raising a `max`, making a field optional —
needs none of this. Existing rows already satisfy a weaker rule.
