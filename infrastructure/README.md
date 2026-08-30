# `infrastructure/`

`pb_schema.json` — the PocketBase collection schema, imported by
[`deploy/setup-pocketbase.sh`](../deploy/setup-pocketbase.sh) on **every deploy**
(`PUT /api/collections/import`, `deleteMissing: false`).

## Before you tighten a constraint, read this

**Tightening a `min`, `max`, `required`, or pattern on an existing field is a data
migration, not a schema edit.** PocketBase re-validates the whole record on every save —
including a partial `PATCH` that never mentions the field you changed — so an existing row
that violates the new constraint becomes permanently unwritable, with no error at import
time and no warning anywhere.

In this system that means the evaluator's status writes start failing with HTTP 400 and
incidents silently stop opening and resolving for the affected monitors.

**[docs/schema-constraints.md](../docs/schema-constraints.md)** explains the mechanism, what
it broke in #319/#320, and the two correct approaches (backfill first, or enforce in the
app layer instead). Loosening a constraint is always safe.

`assets/` — images referenced by the schema/docs.
