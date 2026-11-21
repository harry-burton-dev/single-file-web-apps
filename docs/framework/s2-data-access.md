# S2: Data access

**Goal:** a screen reads with a hook and writes with a command. It never sees the engine, Yjs or a file.

## Start from

- `framework/engine/src/records/` (`openTable`, `createTable`, field rules "latest", "ask", "text"): built and tested, unused by the app.
- ADR-0007 (commands and table registry), ADR-0008 (query layer), ADR-0002 (conflict rules).
- `app/use-engine.ts`: the stand-in `useSharedText` to be replaced.

## Deliver

1. **Table registry.** At start, every table in `app.config.ts` is opened through the record layer with its schema. Unknown tables in the folder are left alone.
2. **Commands.** `defineCommand(name, (tx, input) => ...)` and `useCommand(name)`. A command is the only way to write; it runs synchronously against the tables and is named in traces. Built-in commands: create, update, remove, restore a record.
3. **Queries.** `useRecord(table, id)`, `useRecords(table, { where, sort })`, `useField(table, id, field)`. They re-render only when their result changes. Filtering and sorting are in memory; no index in v0.1.0.
4. **Conflicts.** For "ask" fields, `useConflicts()` lists open conflicts and `resolveConflict(...)` settles one. The shell (S4) supplies the default prompt.
5. **Boundary check.** A test or lint rule fails if a file under `app/` imports anything other than the public entry (gate G5).

## Defaults chosen

- No undo stack in v0.1.0; commands are recorded so one can be added.
- Queries are plain functions over arrays. Tables are expected to hold thousands of records, not millions.
- Typed results come from the schema in `app.config.ts` by inference, with no code generation step.

## Acceptance

- Unit tests for each hook and built-in command against an in-memory engine, written first.
- A test with two engines on one memory folder: a command on one appears in the other's `useRecords` result.
- A concurrent edit to an "ask" field appears in `useConflicts()` on both, and resolving it on one clears it on both.
- Gate G5 check exists and fails when a deliberate bad import is added (then removed).

## Out of scope

Plugins, full-text search, undo, server-style pagination.
