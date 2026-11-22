# ADR-0007: Command layer and table registry

**Status:** Accepted, reduced for v0.1.0 (built in TR2, 2026-11-21; see "As built")
**Date:** 2026-11-21
**Deciders:** Harry
**Epic:** EA · EA Workbench
**Related:** ADR-0001 (sync engine), ADR-0002 (data model and conflicts), ADR-0004 (activity), ADR-0006 (plugins)

## Context

The record layer (ADR-0002) lets any code write to any table. If screens and plugins do that directly, validation, activity logging, undo and permission checks each have to be repeated wherever a write happens, and none can be relied on.

Three further facts shape the design:

- **Yjs cannot roll back.** A write that fails halfway leaves the first half in place.
- **Tables sync independently.** Changes to two tables made together can reach a colleague at different moments.
- **Plugins (ADR-0006) need a fixed way to add data and actions** without touching the engine, the folder or Yjs.

## Decision

Two parts that depend on each other: a **table registry** that declares what data exists, and a **command layer** that is the only way to change it.

### 1. Table registry

Each table is declared once:

```js
defineTable({
  name: "checklist-items",
  version: 1,
  fields: {
    entry: { kind: "latest", type: "ref" },
    label: { kind: "latest", type: "string" },
    done:  { kind: "latest", type: "boolean" },
    room:  { kind: "ask",    type: "string" },
    notes: { kind: "text" },
  },
});
```

- `kind` is the conflict behaviour from ADR-0002: `latest`, `ask` or `text`.
- `type` is used to validate values written by commands.
- The registry is the single source for: the list of tables the engine syncs, the schemas the record layer opens them with, and what commands and queries may refer to.
- A table's version follows ADR-0002: additive changes only, and an app that sees a newer version stops writing to that table.
- Plugin tables are registered the same way, under the name `<pluginId>.<table>`.

### 2. Commands

A command is declared once, with a name, the input it accepts, and a function that works out what should change:

```js
defineCommand({
  name: "checklist.applyTemplate",
  title: "Apply template",
  input: { entryId: "string", templateId: "string" },
  plan({ read, ids, now, user }, { entryId, templateId }) {
    const template = read("templates").get(templateId);
    if (!template) return fail("Template not found");
    return template.items.map((item) =>
      put("checklist-items", ids.from(entryId, item.id),
          { entry: entryId, label: item.label, done: false }));
  },
});

const result = await commands.run("checklist.applyTemplate", { entryId, templateId });
// { ok: true, changes: [...] }   or   { ok: false, error: "Template not found" }
```

**Nothing changes data except by running a command.** Screens, plugins, shortcuts and tests all use `commands.run`.

### 3. Commands plan; the layer applies

`plan` writes nothing. It reads current data and returns a list of changes. The layer applies them.

The change vocabulary is small:

| Change | Meaning |
|---|---|
| `put(table, id, fields)` | Create or update the given fields |
| `remove(table, id)` / `restore(table, id)` | Mark deleted, or undo that |
| `text(table, id, field, newValue)` | Edit a `text` field so concurrent edits merge |
| `resolve(table, id, field, value)` | Settle an `ask` conflict |

This is chosen because Yjs cannot roll back: everything is decided, and validated, before anything is written.

### 4. What the layer does on each run

1. **Validate the input** against the declared shape.
2. **Check it is allowed:** the app is not too old for the tables involved, and the user is not read-only.
3. **Plan:** call the command's function with a read-only view of the data.
4. **Validate the changes:** every table is registered, every field exists, every value matches its type, no deleted record is written to.
5. **Apply** all the changes as one group.
6. **Record** the run in the activity log and on the undo stack.
7. **Return** a result.

A command reports failure by returning a result. It does not throw. A fault inside `plan` is caught and returned as a failed result, with nothing written.

### 5. Rules for command functions

- **No clock, randomness or outside calls.** Time, the user, the device and new ids come in from the layer. The same data and input always give the same changes.
- **Predictable ids where two people might do the same thing.** `ids.from(...parts)` builds an id from its parents, so two people applying the same template land on the same records. `ids.new()` gives a random id for things that are genuinely separate.
- **Tolerate missing references.** A change set touching two tables is applied together locally but may arrive on another device in two steps.

### 6. Undo

- Each command's changes are applied as one group per table, tagged with the command run.
- Undo reverses the last command the local user ran, across every table it touched. It never reverses a colleague's changes.
- Undo and redo are themselves recorded as activity.

### 7. Activity

- Locally, every run is logged: command, input summary, user, device, time, records touched, result.
- For colleagues to see intent ("Harry applied the Board template to Acme review") rather than a list of field edits, each successful run also writes one small record to a synced `activity` table. A command can opt out with `log: false`.
- The synced activity table grows; it is trimmed by age, which is safe because it is history, not state.

### 8. What sits on top

- **Screens** bind buttons and forms to commands.
- **A command palette and keyboard shortcuts**, since every action has a name and a title.
- **Plugins** register tables and commands through this layer and nothing else.
- **App-level simulation tests:** because commands are deterministic, the engine's simulator can run random command sequences on several devices and check the app's own rules.

### 9. Placement

```
screens / plugins
      | run a command            ^ subscribe to queries
command layer  ----------------  query layer
      | changes                  ^ reads
           record layer (tables, fields, conflicts)
                    |
               sync engine
```

Reads go through a separate query layer (its own ADR). The command layer and registry are pure code with no browser dependency. They live beside the engine and are tested in Node.

### As built (TR2, spec S2)

What v0.1.0 has, where it differs from the sections above:

- **Registry (section 1).** There is no `defineTable`. Tables and fields are declared once in `app/app.config.ts` (`AppDefinition`, spec S1). A field is a kind (`"latest"`, `"ask"`, `"text"`) or `{ kind, type }` with a type of `"string"`, `"number"` or `"boolean"`; `"ref"` is not a type. At start, `createData` opens every declared table through the record layer (`framework/data/registry.ts`); tables the definition does not name are left alone. Plugin tables are not built (ADR-0006 is later).
- **Commands (sections 2 and 3).** `defineCommand(name, (tx, input) => value)`, run with `useCommand(name)` in screens or `data.run` in the framework. The handler calls `tx.put / remove / restore / resolve`, which only buffer: nothing is written until it returns, every change is checked, then each table is written in one batch. So commands still plan and the layer applies, without a separate change vocabulary. There is no `text(...)` change: a `put` to a text field is diffed into the shared text, so concurrent edits merge. Reads (`tx.get`, `tx.list`) are a snapshot taken on first use and do not see the command's own changes.
- **Built-ins.** `records.create`, `records.update`, `records.remove`, `records.restore`, `records.resolve`, taking the table name as input, so the framework names no app table (G4).
- **Checks (section 4).** Steps 2, 4, 5 and 7 are built: unknown table or field, wrong value type, a write to a deleted record and a table stored at a newer schema version all fail with nothing written. Step 1 is not: there is no input schema, so handlers check their own input. Read-only users are not checked.
- **Results.** `run` is synchronous and never throws: `{ ok: true, value, changes }` or `{ ok: false, code, error }`, with code `failed`, `invalid`, `schema-too-new` or `unknown-command`. A run notifies the screens reading the written tables before it returns.
- **Not built in v0.1.0:** undo (section 6), the synced `activity` table (section 7), titles, the command palette and permissions. Each run is kept in a local, per-device log of the last 200 runs, with every touched record's prior row, so undo can be added.

## Options Considered

| Option | Complexity | Drawback |
|---|---|---|
| **A. Planned commands plus a table registry (chosen)** | Medium | Every write needs a declared command; some ceremony for trivial edits |
| B. Commands that write directly inside a transaction | Low to medium | A fault partway leaves half the changes in place; changes are not known until after they happen |
| C. No command layer; screens call the record layer | Low | Validation, activity, undo and permissions repeated and unreliable; plugins get unrestricted write access |
| D. Full event sourcing (store commands, derive all state) | High | Replaying commands across devices needs a total order, which a lagging file-sync folder cannot give; the CRDT already solves merging |

## Trade-off Analysis

- **Plan-then-apply over write-as-you-go:** costs a small vocabulary of changes and a little indirection; removes partial writes and makes every command a testable function.
- **Commands as the unit of activity and undo:** a person thinks "I applied a template", not "I set nine fields". Recording at that level makes the feed and undo match intent.
- **Not event sourcing:** commands are logged for people to read, but the data is the Yjs documents. Rebuilding state from a command log would need every device to agree on order.
- **A generic `put` command is allowed** for simple edits, so the ceremony stays low where there is no logic to capture.

## Consequences

**Easier**

- One place for validation, permission checks, activity and undo.
- Plugins add features without access to anything below this layer.
- App behaviour can be simulation-tested the same way the engine is.

**Harder**

- A command cannot read, write, then read its own write; it must plan from the data as it stood.
- Changes across tables are not atomic for other devices.
- The change vocabulary and the registry format become part of the plugin contract, so they are costly to alter later.
- The synced activity table adds data and needs trimming.

**To revisit**

- Whether some commands need a confirmation step before applying.
- Read-only roles, once a principal's view is designed.
- The query layer, which this ADR assumes.

## Action Items

1. [x] Build the table registry and wire it to the engine's table list and the record layer's schemas (TR2).
2. [x] Build the command layer: planning, change validation, apply, result (TR2). Input validation is left to each handler.
3. [ ] Add per-command undo across tables.
4. [ ] Add the local activity log and the synced `activity` table.
5. [ ] Add a command-sequence workload to the simulator.
6. [x] Write the query layer ADR (ADR-0008).
