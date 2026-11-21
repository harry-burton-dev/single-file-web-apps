# Sync engine: properties, contracts, variants and scoring

Issue: OUT-6. Requirements: ADR-0001 to ADR-0004 in this folder. Code: `sync-engine/` at the project root (ES modules, Node 24, `node --test`, no build step, no TypeScript).

This file is the shared contract for everyone building or testing the engine. If code and this file disagree, raise it; do not silently pick one.

## 1. Properties (the suite exists to check these)

| Id | Property | How it is checked |
|---|---|---|
| P1 | **Convergence.** Once every device is online, has saved, and the folder has fully synced, every device holds identical content for every table. | Compare `adapter.toJSON` across devices after `world.quiesce()` |
| P2 | **Nothing lost, nothing invented.** The converged content equals an oracle: one document to which every durable local update from every device was applied directly. | Oracle fed from `onLocalUpdate` at source |
| P3 | **Local durability.** A change is durable once the engine has accepted it. Closing or crashing the app without saving, then reopening with the same local store, loses nothing. | Crash and reopen in the simulator |
| P4 | **Compaction safety.** A file is deleted only if a snapshot covers it, every active device has acknowledged that snapshot, the snapshot is at least the minimum age, and the deleter wrote the file. After any history including compaction, a brand-new device still reaches the oracle. | Simulator records every delete and validates it against folder state at that moment; new-device join |
| P5 | **Catch-up.** A device offline for weeks converges after returning. | Offline fault |
| P6 | **Rebuild.** A wiped local store refills from the folder. An emptied folder is re-seeded from one device. | Wipe faults |
| P7 | **Tolerance.** Truncated files, garbage files, conflict copies, `.crswap` and unknown files never throw out of `tick()` and never change content. | Fault injection |
| P8 | **Single writer.** A device never creates, changes or deletes a file outside its own device paths (`data/*/<deviceId>/…`, `status/<deviceId>.ywb`). | Simulator checks every write and delete |
| P9 | **Progress and pacing.** With no faults, a change reaches the folder within `maxWaitMs + minIntervalMs`. Saves triggered by timing are never closer together than `minIntervalMs`. | Trace check |
| P10 | **Conflict values.** For an `ask` field, writes made without knowledge of each other are all retrievable until one write resolves them; the resolution clears the conflict on every device. | Record-layer tests on both adapters |
| P11 | **Digest agreement.** Two devices reporting the same applied state report the same table digest. | Status files |
| P12 | **Determinism.** The same seed and configuration produce the same trace hash. | Run twice |
| P16 | **No nonce reuse.** No two different files are encrypted with the same key id and IV. | Simulator inspects every engine write; same key id and IV with a different authentication tag is a violation |

P4 as checked: a deleted chunk must be listed by identity in the covering snapshot (`ids[device][seq]` equals the chunk's id), not only fall under its `covers` number. A conflict copy uses its primary's id.

A change lost because a device's local store was wiped before the change was ever saved to the folder is not a violation; the oracle drops such updates.

## 2. Contracts

All functions that touch the folder, store or crypto are `async`. No module may use `Date.now()`, `Math.random()`, `setTimeout` or global state directly; they come in through the injected dependencies.

### 2.1 Clock and randomness

```js
clock.now()            // milliseconds, number
random.bytes(n)        // Uint8Array of n bytes
random.float()         // [0, 1)
```

The engine has **no timers**. It is driven by `engine.tick()`, which the host calls about once a second and which decides from `clock.now()` what is due.

### 2.2 Folder (subset of the File System Access API)

```js
dir.kind === "directory"; dir.name
await dir.getDirectoryHandle(name, { create })   // NotFoundError if missing and !create
await dir.getFileHandle(name, { create })
await dir.removeEntry(name, { recursive })
for await (const [name, handle] of dir.entries()) {}

file.kind === "file"; file.name
const f = await file.getFile();   // { name, size, lastModified, arrayBuffer() }
const w = await file.createWritable();   // replaces whole content
await w.write(uint8array); await w.close();   // content visible only after close
```

Errors are objects with a `.name`: `NotFoundError`, `NoModificationAllowedError`, `NotReadableError`, `AbortError`, `TypeMismatchError`. The engine must treat any of them on read as "skip, retry next scan" and on write as "retry later".

### 2.3 Local store

```js
await store.get(key)          // undefined if absent; values are Uint8Array or plain JSON
await store.set(key, value)
await store.delete(key)
await store.keys(prefix)      // string[]
```

### 2.4 CRDT adapter

```js
adapter.name                          // "yjs" (the only adapter; Automerge was dropped 2026-11-21)
adapter.create()                      // new empty document
adapter.onLocalUpdate(doc, cb)        // cb(bytes: Uint8Array) for each LOCAL change; returns unsubscribe
adapter.applyUpdate(doc, bytes, origin)   // must not trigger onLocalUpdate
adapter.snapshot(doc)                 // whole document as one update (Uint8Array)
adapter.compact(updates)              // optional: Uint8Array[] -> Uint8Array[] (fewer)
adapter.toJSON(doc)                   // plain, canonical (sorted keys) JSON value for comparison
```

Required of every adapter: applying an update twice, or updates in any order, gives the same result; an update whose dependencies are missing is held and takes effect when they arrive.

### 2.5 Engine

```js
const engine = await createEngine({
  root,            // folder handle of the workspace root
  clock, random, store,
  key,             // CryptoKey, AES-GCM 256
  keyId,           // 0-255
  user, deviceId,  // deviceId = "<user>-<8 chars>"
  adapters,        // { yjs: adapter }
  timer,           // optional { now() }, monotonic ms for durations
  listeners,       // optional { event: fn }, subscribed before the startup scan
  tables,          // { notes: "yjs", ... }
  options,         // section 3
});
engine.table(name)        // the adapter's document
await engine.tick()       // do whatever is due: save, scan, status, compaction
await engine.flush()      // save now (window hidden/closed)
await engine.scan()       // read the folder now
engine.status()           // { pending, lastSaveAt, lastScanAt, devices: {...}, errors: [...] }
engine.on(event, fn)      // "received" {table, device, writtenAt}, "saved", "error"
await engine.close()      // flush then stop
await engine.reseed()     // write full snapshots of every table into own folders
```

`tick()` must never throw and must not leave work running after its promise resolves.

File names, envelope format, folder layout, save timing, reading rules, status files and compaction are as written in ADR-0001 and ADR-0004. The envelope's decrypted body is: 4-byte big-endian metadata length, metadata JSON, then a sequence of updates each prefixed by a 4-byte big-endian length.

### 2.6 Simulator

```js
const world = createWorld({ seed, faults });
const dev = world.addDevice("harry-aaaaaaaa");   // { root, id }
world.clock; world.random(name)   // independent seeded streams
await world.advance(ms)           // moves time, delivers due sync events
world.setOnline(id, bool)
await world.quiesce()             // deliver everything outstanding, faults off
world.log                         // every write, delete, delivery with time, device, path, size
world.stats()                     // files and bytes in the cloud, bytes uploaded, per device
world.traceHash()
```

Model: each device has its own view of the folder; a "cloud" holds the canonical copy. A local write reaches the cloud after an upload lag, and other devices after a further download lag, each drawn from the seeded stream per file. Fault knobs (all default off, all seeded): lag ranges; a file visible truncated before its full content arrives; delete arriving before a create it depends on; conflict copy named `<base>-<DEVICE>.<ext>` when two devices write the same path; a `.crswap` file visible beside a target while a write is open and occasionally left behind; write `close()` failing with `NoModificationAllowedError`; first read of a newly arrived file failing with `NotReadableError`; a device offline for a period; junk files.

### 2.7 Observability (ADR-0004 sections 3 to 6)

```js
timer.now()                 // injected monotonic milliseconds, for durations only (simulator: deterministic)
engine.on("trace", fn)      // one per sync attempt
engine.traces({ kind, outcome, table, device, limit })   // recent history, newest first
engine.metrics()            // ADR-0004 section 4
engine.health()             // { state, since, detail, lastSaveAt, lastScanAt, lastScanOkAt, pending, nextSaveAt, retryAt,
                            //   peers: { device: { user, lastHeardAt, lastAckedAt, active, ackedLatest, waitingSince } } }
engine.on("health", fn)     // { state, previous, since } on every change of state
engine.setOffline(bool)     // the host's network hint
engine.noteConflict({ type, table, id, field })   // "ask-opened" | "ask-resolved" | "overlap", reported by the record layer
engine.setTraceLevel(level) // "off" | "summary" | "full"
```

A trace is `{ id, kind: "save"|"scan"|"status"|"compaction"|"reseed", device, user, startedAt, endedAt, durationMs, outcome: "ok"|"partial"|"failed"|"skipped", reason, tables, devices, counts, steps: [...], truncated? }`. A step is `{ at, table, path, action: "read"|"stat"|"list"|"write"|"delete"|"skip"|"apply", bytes, durationMs, result, error }`. Traces hold no record content.

As implemented:

- **Levels.** `full` keeps every step; `summary` keeps counts only; `off` keeps no traces, but durations and counters are still collected so `metrics()` works.
- **Reasons.** Saves: `quiet`, `max-wait`, `retry`, `forced`; skipped saves: `min-interval`, `backoff`, `nothing-pending` (one skipped trace per reason, not one per tick). Scans: `startup`, `scheduled`, `forced`.
- **History.** The newest 500 traces are kept in memory and about 200 in the local store, written in batches of 10, so a crash can lose the last unwritten batch. A stored trace keeps at most 100 steps; an in-memory trace at most 2000.
- **Acknowledgement** means a peer's status shows it has seen this device's latest written chunk, sealed or not. Only the `chunks` layout has sequence numbers, so only it can report `not-reaching-peers` or acknowledgement lag.
- **`folder-disconnected`** is set when the root cannot be listed, when any operation fails with `NotAllowedError` or `SecurityError`, or when creating a file directly under the root fails with `NotFoundError`. It clears on the next success of the same kind.
- **State priority:** `offline`, `folder-disconnected`, `retrying`, `saving`, `not-reaching-peers`, `saved`.

`health().state` is one of `saved`, `saving`, `retrying`, `folder-disconnected`, `not-reaching-peers`, `offline`. The host passes `offline` in as a hint; the engine derives the rest.

Properties added:

| Id | Property |
|---|---|
| P13 | **Every attempt is traced.** Each folder write and delete in the simulator log falls inside exactly one trace step with the same path (and, for writes, the same size). Deletes are matched on path and time only: the engine does not know the true size of a file it deletes without reading it. Reads are not in the simulator log, so they are checked as per-device totals against the simulator's counters. |
| P14 | **Health is truthful.** `saved` implies no pending updates and no own file owed to the folder; `saving` implies pending updates or `repairing` (an own file vanished or was replaced and is not yet written again); `retrying` implies the last save failed, and a failed last save with updates pending implies `retrying`; `not-reaching-peers` appears when, and only when, an active peer's acknowledgement is older than the threshold. |
| P15 | **Observation does not change behaviour.** Turning tracing detail up or down leaves the trace hash of the simulator log and the final content unchanged. |

In the simulator `offline` and `folder-disconnected` have no cause, so seeing either is a P14 violation; those two states are covered by unit tests only.

## 3. Options (the variant knobs)

| Option | Default | Variants |
|---|---|---|
| `layout` | `"chunks"` | `"state-per-device"` (one rewritten state file per device), `"shared-file"` (one file per table written by all) |
| `chunkContent` | `"merged"` | `"framed"` (keep each update separately) |
| `sealBytes` | 65536 | 16384, 262144 |
| `newChunkPerSession` | `true` | `false` (continue the last unsealed chunk) |
| `quietMs` / `maxWaitMs` / `minIntervalMs` | 30000 / 180000 / 30000 | 2000 / 10000 / 2000 (eager) |
| `scanMs` | 30000 | |
| `statusMs` | 60000 | |
| `ownCheckMs` | 600000 | How often own sealed chunks are compared with the folder, and the least time between two repairs of one table |
| `compaction.enabled` | `true` | `false` |
| `compaction.chunkThreshold` | 200 | 50 |
| `compaction.snapshotMaxAgeMs` | 7 days | |
| `compaction.minSnapshotAgeMs` | 24 hours | 0 |
| `compaction.activeWindowMs` | 30 days | |
| `compaction.ackRule` | `"all-active"` | `"none"` (delete as soon as a snapshot exists; expected unsafe) |
| `trace.level` | `"full"` | `"summary"`, `"off"` |
| `trace.memoryLimit` / `storeLimit` / `persistBatch` | 500 / 200 / 10 | |
| `health.peerActiveWindowMs` / `ackTimeoutMs` | 15 min / 10 min | |

## 4. Scoring (fixed before any run)

1. **Any property violation on any seed disqualifies a variant.** Report the seed and the smallest reproduction.
2. Surviving variants are ranked on, measured over a simulated year of a standard workload (3 users, 4 devices, 10 tables, about 2 sessions per device per working day, 20 to 60 changes per session):
   - files in the folder at the end, and the peak;
   - bytes written to the folder in total;
   - time from a change to its arrival on the last device (median and 95th percentile), sync lag excluded and included;
   - bytes and files read by a brand-new device to load everything;
   - largest single file.
3. Ties go to the simpler variant (fewer code paths).

## 5. Limits of the simulator

Every fault parameter is an assumption drawn from documentation, not a measurement. Simulation can show the logic is sound under the modelled faults. It cannot show that OneDrive behaves as modelled; that needs traces recorded from the real folder.

### 5.1 Planted-bug check (2026-11-21)

23 bugs were planted one at a time in copies of the engine and record layer. The simulation alone caught 6, the unit tests alone 13, either 15; 8 were caught by neither. The two catch nearly disjoint sets, so both are required. A test now exists for each of the misses and each was confirmed to fail with its bug planted: chunk finality by recorded size, minimum snapshot age, retry back-off cap, edits made during a save, IV reuse (also P16), unreadable status of a device with no data files, chunk identity in coverage (also the stricter P4), shadow republish followed by a save, persisted chunk high-water mark, and trace device attribution.

Known remaining limits:

- Simulator actions run only between awaited engine calls, so an edit during an in-flight write is covered by a unit test, not by simulation.
- The `short` scenario never reaches compaction. Compaction faults show only in `compact`, so a release gate must include both.
- The simulator runs only the default `chunks` layout and has no read-only device.
- Fault profile `outage` (rough settings, plus a byte-exact conflict copy of a chunk and every write failing for 10 to 60 minutes) covers sustained failure, which `rough` and `hostile` almost never produce.
- Record-layer rules (tie-breaks, conflict candidate counts, schema version) are covered by unit tests only.
