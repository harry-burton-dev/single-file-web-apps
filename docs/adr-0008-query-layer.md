# ADR-0008: Query layer

**Status:** Proposed
**Date:** 2026-11-21
**Deciders:** Harry
**Epic:** EA · EA Workbench
**Related:** ADR-0002 (data model and conflicts), ADR-0006 (plugins), ADR-0007 (commands and table registry)

## Context

ADR-0007 makes commands the only way to write. This ADR covers the other half: how screens and plugins read.

Reading has three problems today:

- **The record layer scans the whole table on every read.** Fields are stored under flat keys (ADR-0002), so finding one record's fields, or all items for one meeting, means walking every key. That is fine for tests and too slow for real screens.
- **Data changes underneath the screen.** A colleague's changes arrive during a scan, in bursts. Screens must update without each one wiring itself to Yjs.
- **Data is incomplete by design.** Tables sync separately, so a record can refer to one that has not arrived, and a field can be in conflict.

## Decision

A **query layer** that keeps an indexed, in-memory picture of each table, answers declared queries from it, and tells subscribers when their results change.

### 1. Table views

For each registered table the layer keeps a **view**: a map from record id to a plain, immutable row.

```js
{ id: "ci_8fk2", entry: "e_41", label: "Room booked", done: false,
  _deleted: false,
  _conflicts: { room: [{ value: "Alpha", user: "harry", writtenAt: 1795200000000 }, ...] } }
```

- A view is built once from the table when it is first needed, then **kept up to date from Yjs change events**. The flat key of each change names the record, so only that row is rebuilt.
- A row that did not change keeps the same object identity, so a screen can skip redrawing it.
- A field in conflict shows its provisional value, with the candidates under `_conflicts` (ADR-0002).
- Views are derived data. They are never saved; they are rebuilt from the local database at start.

### 2. Indexes

The table registry (ADR-0007) can declare indexed fields:

```js
defineTable({ name: "checklist-items", fields: { ... }, indexes: ["entry"] });
```

An index maps a field value to the set of record ids holding it, and is maintained from the same change events. "All items for this meeting" is then a lookup, not a scan.

### 3. Queries

Two levels, both read-only.

**Row queries** select from one table:

```js
rows("checklist-items", { where: { entry: entryId }, sort: "order" })
```

`where` uses an index when one exists and falls back to a scan when it does not. Deleted records are left out unless asked for.

**Named queries** combine tables with a plain function:

```js
defineQuery({
  name: "entry.readiness",
  params: { entryId: "string" },
  uses: ["checklist-items"],
  select({ rows }, { entryId }) {
    const items = rows("checklist-items", { where: { entry: entryId } });
    return { done: items.filter((i) => i.done).length, total: items.length };
  },
});
```

- `uses` lists the tables a query depends on. The query is re-run only when one of them changes.
- A query function is pure: no clock, no randomness, no writes. Anything time-dependent ("due today") takes the time as a parameter.
- Plugins define queries the same way, under their own name prefix.

### 4. Subscriptions

```js
const stop = queries.subscribe("entry.readiness", { entryId }, (result) => render(result));
queries.get("entry.readiness", { entryId });   // one-off read
```

- **Notifications are batched.** A scan can apply hundreds of changes; subscribers are told once, after the batch, not once per change.
- **A subscriber is called only if its result actually changed**, compared structurally.
- **A command's changes are visible to queries as soon as the command returns.**
- Identical subscriptions share one computation.

### 5. Incomplete data

- **A reference to a record that has not arrived resolves to nothing**, not an error. A `ref(table, id)` helper returns the row or `null`, and query functions must handle `null`.
- **Conflicts are data, not a failure.** `queries.get("conflicts")` lists every open conflict across tables, for the one "needs a decision" view.
- There is no "loading" state for a table: views are filled from the local database before the app starts. Whether colleagues' changes have arrived is reported by the engine's health (ADR-0004), separately.

### 6. Reads inside commands

A command's `plan` function (ADR-0007) reads through the same views, as a snapshot taken when the command starts.

### 7. Scale

The target is tables of up to about 50,000 records. At that size, re-running a named query when a dependency changes is acceptable, so queries are recomputed whole and not updated incrementally. Long lists are windowed by the screen. Full-text search is out of scope and would get its own index.

### 8. Placement and UI

The layer is plain code with no browser or UI-framework dependency, tested in Node. `subscribe` is the only binding point; whichever UI approach is chosen wraps it in a few lines. The UI approach is a separate decision.

## Options Considered

| Option | Complexity | Drawback |
|---|---|---|
| **A. In-memory views with indexes, declared queries, batched subscriptions (chosen)** | Medium | Views use memory roughly equal to the data; rebuilt at every start |
| B. Read the record layer directly on every use | Low | Whole-table scan per read; every screen wires itself to change events |
| C. An embedded SQL database | High | Needs WebAssembly, which the build rules out (ADR-0005); a second copy of the data to keep in step |
| D. A reactive store library as the read model | Medium | A dependency and a second source of truth for the same data |
| E. Screens observe Yjs themselves | Low at first | Yjs leaks into every screen and plugin; no indexing; conflicts and missing references handled differently everywhere |

## Trade-off Analysis

- **Recompute over incremental update:** incremental joins are faster and far harder to get right. At the target size, recomputing a query on change costs little, and a wrong result costs trust.
- **Declared dependencies over automatic tracking:** listing `uses` is slightly more to write, and makes it obvious, and checkable, what a query depends on.
- **Derived, unsaved views:** start-up pays a rebuild, in exchange for views that can never disagree with the data.

## Consequences

**Easier**

- Screens and plugins read with one line and stay current without knowing about Yjs or sync.
- Missing references and conflicts are handled the same way everywhere.
- Queries are plain functions, so they are easy to test.

**Harder**

- A query that forgets a table in `uses` will go stale. A development-time check should catch a query reading a table it did not declare.
- Memory use grows with the data.
- Very large tables would need incremental queries or paging; that is a later change.

**Checked by simulation**

After any sequence of commands and synced changes, every view, index and query result must equal a fresh computation from the tables. This is added as a property to the simulator.

## Action Items

1. [ ] Build table views maintained from change events, with the equality property above.
2. [ ] Add indexes declared in the table registry.
3. [ ] Add row queries, named queries, and batched subscriptions.
4. [ ] Add the development-time check for undeclared table reads.
5. [ ] Replace the record layer's whole-table scans with view lookups.
6. [x] Decide the UI approach: React, see ADR-0009.
