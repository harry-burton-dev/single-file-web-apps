# S5: Durability

**Goal:** the faults every app would inherit are closed, and data survives schema change and folder loss.

## Start from

- `framework/engine/test/breaker/p14-crash-points.probe.js`, `p14d-pending-not-applied.probe.js`, `p15-misc.probe.js`, `p15b-idle-keys.probe.js`: the failing probes are the specification for part A.
- `framework/engine/src/engine/local-state.js` (`addPending`, `logUpdates`), `tracing.js` (segment keys), `health.js` (`peerView` uses `lastActiveAt`).
- `framework/engine/src/records/keys.js`, `table.js` (`schemaTooNew`).
- ADR-0001 "Open" list; ADR-0005 folder layout (`backups/`).

## Deliver

**A. Engine faults (gate G10)**
1. An edit survives a crash at any store call after it is made (P14a, P14b).
2. Stored trace segments do not grow while idle (P15).
3. Health judges a colleague "active" by when this device last saw their status change, as deletion already does.
4. All probes move into CI.

**B. Schema versions (half of gate G9)**
1. Each table's schema carries a version in `app.config.ts`.
2. An app opening a table written at a higher version refuses to write it and shows "this app is older than the data; load the new version", and keeps other tables working.
3. `migrations: { <table>: { <fromVersion>: (record) => record } }` run lazily as records are read and written back by command, so two devices on different versions never fight.

**C. Backup and restore (other half of G9)**
1. Admin page: "Back up now" writes one encrypted file per table (a snapshot) into `backups/<date>/`, and "Download backup" gives a single file.
2. Admin page: "Restore into an empty folder" from that file.
3. The engine's existing `reseed()` is the mechanism; no new file format.

## Defaults chosen

- Part A may change engine internals but no file format.
- Migrations are additive and per record; no whole-table rewrite step.
- No scheduled backups in v0.1.0; the admin triggers them.

## Acceptance

- `npm run probes` exits 0 and is a CI step.
- Simulation limit for part A: `short`, baseline, `rough` and `hostile`, seeds 1..30, zero failing. No longer runs.
- Tests, written first: older app refuses a newer table; a migration applied on one device converges with an unmigrated device; backup then restore into an empty folder gives byte-equal table contents as JSON.

## Stop and report if

Closing P14 needs a change to the pending-update store format that an existing local store could not be read with.
