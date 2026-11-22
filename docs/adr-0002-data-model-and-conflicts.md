# ADR-0002: Data model and conflict handling

**Status:** Proposed
**Date:** 2026-11-20
**Deciders:** Harry
**Epic:** EA · EA Workbench
**Related:** ADR-0001 (sync engine), ADR-0004 (observability)

## Context

The sync engine (ADR-0001) guarantees that every device ends up with the same data. It does not guarantee that the result is the one people wanted.

Example: two people change the same field at the same time, one to 2pm and one to 4pm. Yjs keeps one and silently discards the other. Neither is necessarily right, and nobody is told. For fields where that matters, the app must keep both values and ask a person.

Yjs has no built-in way to report this. A `Y.Map` field is last-writer-wins, and the losing value is not exposed through its public API.

This ADR defines the record model that sits on the engine's tables, and how conflicting edits are detected, kept and resolved. It stays generic so any app on the engine can use it.

## Decision

### 1. Tables and records

- One table per record type, like a database. A table is one Yjs document (ADR-0001).
- **Fields are stored under flat keys** (`<record id>` + separator + `<field>`), not as a nested map per record. If two devices created the same predictable-id record at once, each would make its own nested container and one side's fields would be lost; flat keys merge correctly (confirmed by test).
- Screens use the record layer's interface and never touch Yjs directly.
- Tables sync independently. A record can arrive before the record it refers to, so every screen must tolerate a reference that is not there yet.
- **Ids:** random by default. Things that must not be duplicated get a predictable id built from their parents (for example meeting plus template item), so two people doing the same action land on the same record.
- **Deletion:** records are marked deleted, not removed, so a concurrent edit is not lost and a bin is possible.
- **Versioning:** each table carries a schema version, stored once per device and read as the highest. A single shared value could be lowered by an old app writing at the same moment as a new one (found by test). An app that sees a newer version than it understands warns and stops writing to that table. Changes to record shapes are additive.
- Anything two people may add to at once is its own record pointing at its parent, never a list inside a field.

### 2. Field kinds

Every field in a table's schema declares how concurrent edits are treated:

| Kind | Behaviour when two people edit at once | Use for |
|---|---|---|
| `latest` (default) | One value wins automatically. The overwrite is flagged in the activity log (ADR-0004). | Most fields: ticks, labels, low-stakes values |
| `ask` | Both values are kept. The field is in conflict until a person chooses. | Fields where a silent wrong answer costs something: times, rooms, names |
| `text` | Edits are merged character by character (`Y.Text`). | Notes and other prose |

Choosing the kind is a per-field schema decision, made when a table is defined.

### 3. How `ask` fields keep both values

An `ask` field is stored as one slot per device instead of a single value:

```
room: {
  "harry-7f3k": { n: 3, value: "Alpha", seen: { "sam-b81x": 1 } },
  "sam-b81x":   { n: 2, value: "Beta",  seen: { "harry-7f3k": 2 } }
}
```

- `n` counts that device's writes to this field.
- `seen` records, for every other device, the latest write this device had received when it wrote.
- **A slot is superseded** if another slot's `seen` covers it. Harry's write 3 is superseded if some slot has `seen["harry-7f3k"] >= 3`.
- **The field's value is the set of slots that are not superseded.** One survivor is the normal case. Two or more means the writes were made without knowledge of each other: a conflict.

In the example, Sam had seen Harry's write 2 but not 3, and Harry had seen Sam's write 1 but not 2. Neither supersedes the other, so both "Alpha" and "Beta" survive.

Each device writes only its own slot, so the slots themselves never collide. No clocks are involved. This is a standard multi-value register, built on a Yjs map in roughly 60 lines.
### 4. Reading and resolving

The record layer gives the app, for any `ask` field:

```js
field.value        // provisional value: the surviving slot, or the most recently written of several
field.conflict     // null, or [{ value, user, device, writtenAt }, ...]
field.resolve(v)   // write v, superseding every current candidate
```

- **The screen is never blocked.** A conflicted field shows a provisional value with a marker. The provisional choice is the same on every device (most recent written-at time, ties broken by device id).
- **Resolving is an ordinary write** whose `seen` covers all candidates. It syncs like any other change, and the conflict disappears for everyone.
- **A list of all open conflicts** is available across tables, so one generic "needs a decision" view can serve every feature.
- If two people resolve the same conflict differently at the same time, that is a new conflict. It is rare and handled by the same mechanism.

### 5. Conflict UI contract

One generic component, used wherever an `ask` field appears:

- Shows each candidate with who set it and when.
- Lets the user pick one or type a different value.
- Is reachable from the field itself and from the open-conflicts list.

Feature screens do not implement their own conflict handling.

## Options Considered

| Option | Complexity | Outcome | Drawback |
|---|---|---|---|
| **A. Per-device slots for `ask` fields (chosen)** | Low to medium | Both values kept, no clocks, independent of Yjs internals | More stored structure per `ask` field |
| B. Last-writer-wins everywhere, with overlap notices | Low | Loser's value shown in the activity log only | Easy to miss; the wrong value stays in place |
| C. Read the losing value from Yjs internals | Medium | No extra structure | Depends on undocumented internals and on disabling Yjs garbage collection |
| D. Use Automerge for its built-in conflict values | Medium | Conflicting values reported natively; no slot code | Dropped with Automerge itself (ADR-0001): its single-file build did not run from disk |
| E. Lock a record while someone edits it | Medium | No conflicts | Locks cannot be trusted across a folder that lags by minutes |

## Trade-off Analysis

- **Kinds per field, not one rule for everything.** Asking a person about every overlapping tick-box would be noise; never asking would hide real mistakes. The schema decides where the line is.
- **Slots over Yjs internals.** The slot design is explicit, testable and would survive a change of CRDT library.
- **Provisional value over blocking.** With minutes of lag and low stakes, showing a best guess with a marker is more useful than freezing the field.

## Consequences

**Easier**

- Features declare field kinds and get conflict handling for free.
- One conflict screen serves every table and every future app on the engine.

**Harder**

- `ask` fields cost more storage and a little more code to read.
- Someone has to resolve conflicts; an unresolved one stays marked indefinitely.
- Changing a field's kind after data exists needs a migration.

**To revisit**

- Whether "deleted" should be an `ask` field (delete versus edit).
- Whether whole-record conflicts are needed, beyond per-field.

## Action Items

1. [ ] Implement the record layer over the engine: tables, ids, deletion, field kinds.
2. [ ] Implement `ask` slots with tests for two and three concurrent writers, and for concurrent resolutions.
3. [x] Build the generic conflict component and the open-conflicts list (TR4: the shell's conflict prompt, `framework/runtime/shell/conflict-prompt.tsx`; it shows user ids, not display names, and offers only the candidate values).
4. [ ] Decide the field kinds for the first EA Workbench tables when those are designed.
