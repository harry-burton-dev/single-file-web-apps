# ADR-0001: Sync engine (Yjs, chunked per-device logs in a synced folder)

**Status:** Proposed
**Date:** 2026-11-20
**Deciders:** Harry
**Epic:** EA · EA Workbench
**Related:** ADR-0002 (data model and conflicts), ADR-0003 (identity, keys, admin), ADR-0004 (observability)

## Context

A single HTML page opened from disk in Chrome or Edge is used by a few trusted people at once. There is no server. The only link between machines is a folder synced by OneDrive.

- OneDrive syncs whole files with a lag of seconds to minutes. Two machines writing the same file in that window produce a conflict copy or a lost write.
- The browser cannot append to a user-visible file. Every save writes a temporary `.crswap` copy and swaps it in, so OneDrive sees a whole-file replacement.
- A reader can see a file that is missing, half-downloaded or mid-replace.
- Libraries can load from a public CDN. Folder access is through the File System Access API, granted once per person.

The engine is meant to be reused: EA Workbench is the first app on it, not the only one. It must know nothing about diaries, notes or checklists.

Reference pattern: Niki Tonsky, "Local, first, forever" (https://tonsky.me/blog/crdt-filesync/), design 3: one append-only operations log per client, split into chunks. The article leaves format, chunk size, naming, compaction and catch-up unspecified, and its demo does not chunk, so those are decided here.

## Decision

Build a **sync engine**: a self-contained module that keeps a set of CRDT documents ("tables") identical across devices by exchanging encrypted chunk files through a shared folder. Each device writes only its own files.

**Yjs is the CRDT library, and the only one** (decided 2026-11-21). The engine still reaches it through a small adapter interface, which keeps the engine testable, but no second library is planned.

Automerge was trialled as a second adapter and dropped. In simulation it behaved the same as Yjs. Bundled into the single-file build it produced a 5 MB page that rendered nothing when opened from disk, against 110 KB for the engine with Yjs, which ran.

### 1. Boundary

| The engine owns | The engine does not own |
|---|---|
| Documents ("tables"), one per name, each through a CRDT adapter | What the tables mean (ADR-0002 defines the record model on top) |
| Local database, chunk files, encryption envelope | Where the key comes from (ADR-0003) |
| Save and read scheduling, retries | Screens, including the sync panel (ADR-0004) |
| Events: changed, saved, received, error | Features |

Surface, in outline:

```js
const engine = await createEngine({ folder, key, deviceId,
  tables: { notes: "yjs", "checklist-items": "yjs" } });
const doc = engine.table("notes");        // the adapter's document, already loaded from the local database
engine.on("received", ({ table, device, writtenAt }) => { ... });
engine.on("error", ...);
engine.status();                          // pending count, last save, per-device progress
await engine.flush();                     // save now
```

**CRDT adapters.** The engine never calls a CRDT library directly. Each adapter provides:

| Adapter function | Purpose |
|---|---|
| `create()` | A new empty document |
| `onLocalUpdate(doc, callback)` | Hand the engine the bytes for each local change |
| `applyUpdate(doc, bytes, origin)` | Apply bytes from the local database or another device |
| `snapshot(doc)` | The whole document as one update, for backups and compaction |
| `compact(updates)` (optional) | Merge several updates into fewer |

Every adapter must guarantee that updates can be applied more than once and in any order with the same result, and that an update whose dependencies have not arrived is held until they do. A table's adapter is fixed when the table is created and recorded in each file's metadata.

### 2. Replicas

- **Local database:** every table is kept in IndexedDB by the engine itself, as stored updates plus a periodic snapshot, the same way for every adapter. The app reads and writes this copy, so it is instant, starts without waiting for the folder, and works while OneDrive is unavailable.
- **Folder:** chunk files, described below.
- Either replica can rebuild the other. A wiped browser refills from the folder; a deleted folder is re-seeded from any one device.
- Local updates not yet written to the folder sit in a pending store and survive a closed tab.

### 3. Folder layout

```
<root>/
  data/
    notes/
      harry-7f3k2m9q/000001.ywb
      sam-b81x0c4d/000001.ywb
    checklist-items/
      harry-7f3k2m9q/000001.ywb
  backups/
```

- **Device id** is `<user>-<8 random characters>`, created on first run in a browser profile. One person on two PCs is two devices.
- **A device writes only files under its own device id**, and never creates, changes or deletes another device's files.
- Names use ASCII letters, digits and `-` only.

### 4. Chunks

- A chunk holds the updates made locally on one device for one table, in that table's adapter format.
- **Its content is a list of length-prefixed updates.** An adapter that can merge updates reduces the list to one (the Yjs adapter does, with `Y.mergeUpdates`).
- The open chunk is rewritten whole on each save. It is **sealed at 64 KB** (tunable) and never touched again.
- **Every session starts a new chunk**, so a file from an earlier session is never built upon.
- **Each chunk records the final size of the one before it.** Files sync independently, so a reader can hold an early copy of chunk 5 while already seeing chunk 6. A reader treats a chunk as finished only when the size it applied equals the size recorded in the next chunk. (Found by simulation: without this, readers silently missed changes.)

### 5. File format

Binary, extension `.ywb`:

| Bytes | Content |
|---|---|
| 0–3 | Magic `EAW1` (format version 1) |
| 4 | Key id (allows key rotation) |
| 5–16 | Random 12-byte IV, new for every write |
| 17– | AES-256-GCM ciphertext; bytes 0–16 are authenticated as additional data |

Decrypted content: a 4-byte length, a JSON metadata block (user, device, table, adapter, schema version, app version, written-at time), then the updates.

- Encryption also gives integrity: a truncated or half-synced file fails authentication and is skipped.
- Binary over JSON because CRDT updates are binary; JSON would need base64 at a third more size.

### 6. Saving

- After a change, wait for **30 seconds of quiet**, then save. Further activity restarts the countdown.
- If activity never stops, **force a save after 3 minutes**.
- **Never save more than once per 30 seconds.**
- **Save immediately when the window is hidden or closed**, overriding the above.
- The pending store is cleared only when the write has completed. Failures (OneDrive or antivirus holding the file) retry with backoff.
- One writing tab per device, enforced with a Web Lock; a second tab opens read-only.

### 7. Reading

On start, on window focus, every 30 seconds, and on a `FileSystemObserver` event where available:

1. List every table folder and device folder.
2. Consider chunk files matching `^\d{6}(-.+)?\.ywb$` and snapshot files matching `^snap-\d{8}T\d{6}Z(-.+)?\.ywb$`, so a OneDrive conflict copy is read as data. Ignore everything else, including `.crswap` and `.tmp`.
3. Skip a file whose name, size and modified time match what was last applied. A chunk proven finished (section 4) is never looked at again; an unfinished one is re-checked on every scan, which is normally one or two files per device.
4. Decrypt. If that fails, skip and retry on the next scan.
5. Apply the update to the local table, tagged with the device and written-at time from the metadata, and emit `received`.

No read position is stored, unlike Tonsky's design. Every adapter's updates are safe to apply repeatedly and in any order.

### 8. Backups and compaction

- **Backup:** a full snapshot of each table as a `.ywb` file under `backups/`. Restoring is placing a snapshot in a fresh folder.

**Compaction is part of the design, not optional.** Every session starts a new chunk per table touched, so three devices and ten tables can produce several thousand small files a year. That slows OneDrive and the first load on a new device.

*Snapshots*

- A snapshot is the **whole table as one immutable file**, written by a device into its own folder: `data/<table>/<device>/snap-<UTC timestamp>.ywb`.
- Its metadata lists what it **covers**: for every device, the highest sealed chunk included. Open chunks are never counted as covered, because they can still grow.
- **Coverage is by identity, not just number.** The snapshot also lists an id for the exact version of each chunk it includes (taken from that file's random IV). A device whose store was wiped can reuse a chunk number; without the id, its new chunk would be treated as already covered, skipped, and later deleted. (Found by simulation.)
- A device that finds one of its own chunks shadowed this way writes a fresh snapshot of its whole table and moves its numbering above the covered range.
- A device writes a snapshot for a table when the table's folder holds more than about 200 chunk files and no snapshot newer than 7 days exists. A random delay avoids several devices doing it at once; if two do, both are valid.
- The admin app can force a snapshot.

*Deleting superseded files*

A chunk is superseded when a snapshot covers it. It is deleted only when all of these hold:

1. **Every active device has acknowledged the snapshot** in its status file (ADR-0004), which proves the snapshot survived OneDrive and could be decrypted elsewhere. A colleague whose status file is currently unreadable, or who has written data but no status yet, counts as not having acknowledged. (Found by simulation: an unreadable status file was being treated as no objection.)
2. The snapshot is at least 24 hours old.
3. The device deleting the chunk is the one that wrote it.

An older snapshot is deleted by its writer under the same conditions once a newer one covers it.

- **Active** means the device's status file has been updated in the last 30 days and the device is not marked retired.
- A device that returns after a long absence loads the newest snapshot, which contains everything, then any chunks not covered. Its own unsaved changes are still in its local pending store.
- **Retired devices:** the admin app may delete a retired device's covered chunks. This is the one exception to "a device deletes only its own files".
- Deleted files go to OneDrive's recycle bin, which is a further safety net.

*Loading*

A device reads the newest readable snapshot for a table first, then only the chunks that snapshot does not cover.

### 9. Library loading

Yjs is bundled into the minted file by the build pipeline (ADR-0005). Nothing is loaded from a CDN at run time.

## Options Considered

| Option | Complexity | Fit | Main drawback |
|---|---|---|---|
| **A. Yjs, chunked per-device logs (chosen)** | Medium | Engine plus Yjs is about 110 KB in the minted file, with no WebAssembly; updates safe to re-apply | Folder layer is ours to write; not field-proven on OneDrive |
| B. Yjs, one state file per device | Low | Simplest reader | Each save re-uploads the device's whole state |
| C. Yjs, one shared file per table | Low | Matches "one file is a table" literally | Depends on OneDrive conflict copies; a write can be lost |
| D. Automerge only | Medium | Reports conflicting values natively; can view earlier states; strings merge as text | Dropped after trial: the single-file build with Automerge was 5 MB and did not render from disk |
| G. Both libraries on the same data | High | None | No bridge exists; two sources of truth |
| E. Loro | Medium | Checksums on import | Same weight as Automerge; younger |
| F. Hand-rolled last-writer-wins log | Low to medium | No dependency | Depends on PC clocks; cannot merge text |

Ruled out because they need a server, relay or a sign-in that fails from a page opened from disk: RxDB, Replicache, Evolu, Jazz, DXOS, Microsoft Graph, hosting in SharePoint.

## Consequences

**Easier**

- New tables need no engine changes. New apps reuse the engine unchanged.
- Conflict copies, duplicate reads and out-of-order arrival do not corrupt data.
- Correctness does not depend on PC clocks.

**Harder**

- Changes reach colleagues in roughly a minute, not instantly.
- Files in the folder are opaque without the app.
- Removed content persists in old chunks and in OneDrive's version history until compaction, and beyond it in version history.

**Not yet verified on a real machine**

- Folder access, IndexedDB and Web Crypto on a page opened from disk, and whether the folder grant persists between sessions.
- Organisation browser policy may disable folder access.
- `.crswap` files reaching colleagues, and OneDrive blocking a save.
- Reading online-only (Files On-Demand) files.
- `FileSystemObserver` firing for changes brought in by OneDrive.
- Pages opened from disk likely share storage, so another local HTML file could read the local database and reuse the folder grant.

## Changes after adversarial testing (2026-11-21)

An independent test pass found eight faults the simulation had missed. All eight are fixed, each with a test.

**Fixed**

- **Own chunks are re-read.** A device used to treat every one of its own chunks below the open one as final and never read it again. After a restored browser profile, the device rewrote a chunk it no longer remembered and then diverged. A device's own chunk is now final only when it carries a `sealed` flag, set when the device sealed it by size or found the folder copy the same size as the copy it had applied. Otherwise it follows the same rule as a colleague's chunk.
- **Snapshots claim only what was applied.** A snapshot's `covers` no longer includes the writer's own chunks by default. An own chunk counts only when applied and sealed.
- **Clock jumps.** Correctness still does not depend on clocks, but scheduling did. A clock that ran ahead and was corrected left stored times in the future, and saving and reading stopped until the clock caught up. At the start of every tick, a stored time ahead of the clock is clamped to now (`clock-guard.js`).
- **Future-dated snapshots.** A snapshot stamped ahead of the local clock is ignored when choosing the newest, so one device with a wrong clock cannot stall everyone's compaction.
- **Peer activity is judged locally.** Whether a colleague's device is active (and so must acknowledge before chunks are deleted) is judged by when this device last saw that device's status file change, on this device's clock. The colleague's own `lastActiveAt` is no longer trusted for this. The time is kept in the local store under `status-seen`. A device not yet observed counts as active.
- **Pending edits after a crash.** Edits found in the pending area at start are applied to the document and logged, as well as re-sent.
- **Sequence numbers from status files are untrusted.** A reported value counts only if it is an integer from 1 to 999998 (`MAX_CHUNK_SEQ`). A forged value can waste numbers but can no longer stop saving.
- **Own files that vanish or are rolled back are written again** (`own-repair.js`). The device that wrote a file is the only one sure to hold its content, so each device watches its own files.
  - *Vanished.* On every scan whose listing had no errors, an own file recorded as written that the listing no longer shows counts as lost, unless a snapshot still in the folder covers it. A direct lookup of the file confirms it first, because a listing can come back short without failing.
  - *Replaced.* When the device reads its own chunk and finds a version other than the one it recorded (by the chunk's version id, not its timestamp), the chunk counts as rolled back. The open chunk is compared on every scan. Sealed own chunks are compared every `ownCheckMs` (10 minutes by default) and at the first scan of a session; the check reads metadata only unless the file changed.
  - *Repair.* If the damaged file is the chunk the session is still writing, it is written again from memory. Otherwise the device publishes one snapshot of the whole table. What is owed is kept in the local store, so it survives a restart. Repairs for one table are at least `ownCheckMs` apart, so two profiles that wrongly share a device id cannot rewrite each other's file in a loop.
  - *Health.* While a repair is owed, health reports `saving` with `repairing: true`, never `saved`.
  - *Cost.* A browser profile restored from backup, or a crash between a write and the store update that records it, looks the same as a rollback and costs one extra snapshot. To keep that rare, the record of a write is now stored as part of the save, not at the next scan.

**Open**

- **Crash within the first few store calls after an edit** loses that edit. Narrowed but not closed; unspecified.
- **Idle growth of stored trace segments** (`trace/seg/*` keys) over thousands of idle ticks.
- The health display still uses the colleague's `lastActiveAt` for "active", so a wrong clock can mislabel a device there. It does not affect deletion.

## Action Items

1. [x] Build the engine with a test page: encrypted chunks and visible status.
2. [x] Test it against a simulated folder that injects lag, conflict copies and truncated files, including deletions that arrive before the snapshot that replaces them.
3. [ ] Run it with all three users from the OneDrive folder and record results against "Not yet verified".
4. [ ] Confirm library versions, CDN URLs and integrity hashes; produce the inlined fallback.
5. [ ] Decide where the folder lives (a synced SharePoint or Teams library is preferred) and set it to "Always keep on this device".
6. [ ] Move status to Accepted, or revise, once results are in.
