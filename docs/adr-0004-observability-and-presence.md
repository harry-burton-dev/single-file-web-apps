# ADR-0004: Observability, activity and presence

**Status:** Proposed
**Date:** 2026-11-20
**Deciders:** Harry
**Epic:** EA · EA Workbench
**Related:** ADR-0001 (sync engine), ADR-0002 (data model and conflicts)

## Context

The app only knows it wrote a local file. It cannot see whether OneDrive uploaded it or whether a colleague received it. A person whose OneDrive is paused or signed out could work alone all day without knowing. Users also want to see what colleagues changed, and who is around.

## Decision

### 1. Status files

Each device rewrites one small encrypted file, `status/<device>.ywb`, at most once a minute while the app is open. It contains:

- **What it has applied:** for each table, the highest chunk it has read from every device, and which snapshots it has loaded. Compaction (ADR-0001) deletes superseded files only after every active device reports the snapshot here.
- **A digest of each table's content.**
- **Last active time**, and optionally what the user is looking at.

| Use | How |
|---|---|
| **Delivery confirmation** | "Sam has received your changes up to 10:42." If a colleague's acknowledgement stops advancing, their sync is stuck. |
| **Out-of-sync detection** | Two devices that report having applied the same chunks must report the same digest. A mismatch is a bug or corruption and raises an alert. |
| **Presence** | "Active in the last few minutes", limited by OneDrive's lag. Not live. |

### 2. Activity log

- Every change applied to a table is recorded locally as who, when, table, record and fields.
- The author is known from the device the chunk came from, so records need no "changed by" field.
- Each device remembers what its user has seen. The difference drives **"what's changed since I last looked"**.
- **Overlap notices:** when a colleague's change replaces a `latest` field the local user changed recently, the log flags it with both values. Conflicts on `ask` fields are handled by ADR-0002 and also appear here.

### 3. Sync tracing

Every sync attempt is recorded as one **trace**: a save, a scan, a status write, a compaction pass or a reseed.

- **Trace:** id, kind, start and end time, duration, outcome (`ok`, `partial`, `failed`, `skipped`), and the reason it ran or did not (quiet period reached, maximum wait reached, minimum interval not yet elapsed, backing off after a failure, forced).
- **Steps inside a trace:** one per file touched, with path, action (read, write, delete, skip), bytes, duration, result and error name; and one per table, with the number of updates written or applied.
- Traces never contain record content: only paths, sizes, counts, device and user names, times and error names.
- The engine emits each trace as an event and keeps a bounded recent history in memory and in the local store, so an attempt made before a reload can still be inspected.
- Durations come from an injected monotonic timer, separate from the wall clock, so they are real in the browser and deterministic in simulation.

### 4. Metrics

Derived from traces and engine state, available at any time:

| Metric | Meaning |
|---|---|
| **Sync duration** | Last, average and 95th percentile time for saves and for scans |
| **Backlog** | Changes not yet saved (count and bytes), age of the oldest, and files seen but not yet readable |
| **Retry state** | Whether saving is backing off, since when, and the next attempt |
| **Throughput** | Files and bytes read and written |
| **Delivery lag** | Time from a colleague writing a file to this device applying it (includes any clock difference between machines) |
| **Acknowledgement lag** | Per colleague, how long since they confirmed receiving this device's latest changes |
| **Conflicts** | `ask` conflicts opened, resolved and still open; overlap notices; OneDrive conflict copies seen; digest mismatches |
| **Errors** | Counts by kind and error name |

### 5. Connection indicator (always visible)

Every screen shows one status, derived by the engine, with the time of the latest sync:

| State | Meaning |
|---|---|
| **Saved** | Everything is written to the folder |
| **Saving** | Changes are waiting; shows how many and when the next save is due |
| **Retrying** | Writes to the folder are failing; shows since when |
| **Folder disconnected** | The folder cannot be reached or its permission has lapsed; changes are safe locally |
| **Not reaching colleagues** | Saves succeed locally, but no colleague has acknowledged them for longer than expected while colleagues were recently active: OneDrive may be paused or signed out |
| **Offline** | The machine reports no network |

Beside it: last successful save, last successful read of the folder, and when each colleague was last heard from.

The app cannot see OneDrive itself. "Not reaching colleagues" is inferred from missing acknowledgements, so it appears with a delay and can be wrong when colleagues are simply away.

### 6. Sync inspector

A full diagnostic view, opened from the connection indicator:

- **Timeline** of every trace, newest first, filterable by kind, outcome, table and device, with a live tail.
- **Trace detail:** every step, file by file, with sizes, durations, the decision reason and any error.
- **Colleagues:** per device, last heard from, what they have acknowledged, snapshots loaded, digest agreement.
- **Metrics** from section 4, with recent history.
- **Files:** unreadable files, unexpected files, conflict copies.
- **Actions:** save now, read the folder now, raise the detail level, export the trace history as a file for diagnosis.

### 7. Storage

The activity log, traces and metrics are local to each device and disposable. They are derived data: losing them loses history of what was seen, not records. Trace history is bounded.

### 8. As built (2026-11-21)

Sections 3 to 5 are implemented in the engine and checked by simulation (properties P13 to P15 in the test spec). Points where the build is more specific than the text above:

- **Detail level.** Tracing has three levels: `full` (every step), `summary` (counts only) and `off`. Metrics work at every level. The level never changes what the engine does.
- **History size.** The newest 500 traces are held in memory and about 200 survive a reload. A crash can lose the last 10. A stored trace keeps its first 100 steps.
- **Acknowledgement** is a colleague's status file showing they have read this device's latest chunk, whether or not that chunk is finished.
- **"Not reaching colleagues"** needs at least one colleague active in the last 15 minutes, and every such colleague to have gone more than 10 minutes without acknowledging. With nobody active it is never shown.
- **"Folder disconnected"** is shown when the folder cannot be listed or a permission error occurs, and clears on the next successful operation of the same kind.
- **"Offline"** is only ever set by the host page passing in the browser's network state.
- **Conflict counts** for `ask` fields and overlap notices are reported to the engine by the record layer; the engine itself counts conflict copies, digest mismatches and size anomalies.
- **Cost.** In simulation, full tracing plus its checks used about 28% more processor time than tracing off. The cost of tracing alone was not separated out.

**Not yet exercised:** any of this against a real OneDrive folder; "folder disconnected" and "offline" outside unit tests.

## Options Considered (presence)

| Option | Liveness | Drawback |
|---|---|---|
| **Status files (chosen)** | Minutes | Not live |
| Browser-to-browser link (Trystero), presence only | Seconds | Relies on public relays; often blocked by corporate firewalls; untested from a page opened from disk |
| Teams or Microsoft 365 presence | Live | Needs a sign-in that fails from a page opened from disk |

A live link can be added later as an optional extra without changing anything else.

## Consequences

- Sync failures become visible instead of silent.
- One extra small file per device is rewritten about once a minute, adding a little OneDrive activity.
- Activity history is per device; a wiped browser starts its history again.

## Action Items

1. [x] Add tracing, metrics and the derived connection state to the engine, with tests.
1. [ ] Build the connection indicator and sync inspector into the engine test page.
2. [ ] Confirm how OneDrive copes with a file rewritten once a minute.
3. [ ] Test the digest check by deliberately corrupting a local table.
