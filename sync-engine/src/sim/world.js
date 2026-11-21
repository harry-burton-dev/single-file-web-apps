// Deterministic simulator of a OneDrive-synced folder (spec section 2.6).
//
// Model
//  - `cloud` is the canonical Map path -> { bytes, version, modifiedAt, writer }.
//  - Each device has its own local view (a tree, see tree.js) and a `seen` map
//    path -> cloud version it last uploaded or downloaded (used to detect
//    conflicts).
//  - A local write is visible locally at once (when close() resolves), is
//    uploaded after a lag, and then reaches every other device after a further
//    lag. Lags are drawn per file event from seeded streams. Events for the
//    same path and direction never overtake each other; different paths are
//    independent, so a delete can arrive before an earlier create elsewhere.
//  - getFileHandle(name, { create: true }) creates an empty file at once, and
//    that empty file syncs like any write (log type "write", size 0), exactly
//    as a real folder would. Empty directories exist locally only.
//  - lastModified: the writer sees the sim time of its local write; a receiver
//    sees the time the file arrived.
//  - A device that is offline keeps working locally. Its outgoing and incoming
//    events are held and delivered, in order, on the next advance() after
//    setOnline(id, true).
//  - addDevice() on a non-empty cloud schedules a download of every file to
//    the new device.
//  - Nothing is delivered until advance() / quiesce(), even with zero lags.
//
// Stats definitions: perDevice.writes counts "write" log entries (successful
// close() plus empty-file creations); reads counts getFile() plus arrayBuffer()
// calls; bytesRead is the sum of arrayBuffer() sizes; filesRead counts
// arrayBuffer() calls (files whose content was read). Failed reads and failed
// writes are not counted.

import { createHash } from "node:crypto";
import { createClock } from "./clock.js";
import { createRandom } from "./prng.js";
import { createEventQueue } from "./queue.js";
import { resolveFaults } from "./faults.js";
import { createDirectoryHandle } from "./handles.js";
import { fsError, notFound } from "./errors.js";
import { createTree, getNode, joinPath, parentPath, putFile, removeNode, walkFiles } from "./tree.js";

const EMPTY = new Uint8Array(0);
const JUNK_NAMES = ["desktop.ini", "~$temp", null]; // null => random "<hex>.tmp"
const MAX_JUNK_BYTES = 32;

// "a/b.c.ext" + "HARRY-1" -> "a/b.c-HARRY-1.ext"
export function conflictCopyPath(path, deviceId) {
  const slash = path.lastIndexOf("/") + 1;
  const name = path.slice(slash);
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return `${path.slice(0, slash)}${base}-${deviceId.toUpperCase()}${ext}`;
}

export function createWorld({ seed = 0, faults = {} } = {}) {
  const random = createRandom(seed);
  const clock = createClock();
  const queue = createEventQueue();
  const devices = new Map();
  const cloud = new Map();
  const log = [];
  const totals = { bytesWritten: 0, bytesUploaded: 0, cloudBytes: 0, peakCloudFiles: 0 };
  let config = resolveFaults(faults);
  let versionCounter = 0;

  const sim = (name) => random.stream(`sim/${name}`);
  const now = () => clock.now();

  function record(type, device, path, size, detail) {
    const entry = { t: now(), type, device, path, size };
    if (detail) entry.detail = detail;
    log.push(entry);
  }

  const drawLag = ([min, max], streamName) => (min === max ? min : sim(streamName).int(min, max));

  // ---- cloud -------------------------------------------------------------

  function cloudPut(path, bytes, writer) {
    const previous = cloud.get(path);
    if (previous) totals.cloudBytes -= previous.bytes.length;
    const entry = { bytes, version: ++versionCounter, modifiedAt: now(), writer };
    cloud.set(path, entry);
    totals.cloudBytes += bytes.length;
    totals.peakCloudFiles = Math.max(totals.peakCloudFiles, cloud.size);
    return entry;
  }

  function cloudRemove(path) {
    const previous = cloud.get(path);
    if (!previous) return;
    totals.cloudBytes -= previous.bytes.length;
    cloud.delete(path);
  }

  // ---- scheduling --------------------------------------------------------

  function scheduleUpload(deviceId, path, op, bytes = EMPTY) {
    const due = now() + drawLag(config.uploadLagMs, "lag.upload");
    queue.push({ kind: "upload", device: deviceId, path, op, bytes }, due, `up|${deviceId}|${path}`);
  }

  function scheduleDownload(deviceId, path, entry) {
    const event = entry
      ? { kind: "download", device: deviceId, path, op: "put", bytes: entry.bytes, version: entry.version }
      : { kind: "download", device: deviceId, path, op: "delete" };
    const due = now() + drawLag(config.downloadLagMs, "lag.download");
    queue.push(event, due, `down|${deviceId}|${path}`);
  }

  function broadcast(path, entry, exceptId) {
    for (const id of devices.keys()) {
      if (id !== exceptId) scheduleDownload(id, path, entry);
    }
  }

  // ---- delivery ----------------------------------------------------------

  function applyUpload(event) {
    const device = devices.get(event.device);
    const { path, bytes } = event;
    if (event.op === "delete") {
      record("upload", device.id, path, 0, "delete");
      cloudRemove(path);
      device.seen.delete(path);
      broadcast(path, null, device.id);
      return;
    }
    record("upload", device.id, path, bytes.length);
    totals.bytesUploaded += bytes.length;
    const existing = cloud.get(path);
    const diverged = existing && existing.version !== device.seen.get(path);
    if (diverged && sim("conflict").chance(config.conflictCopy.probability)) {
      storeConflictCopy(device, path, bytes, existing);
      return;
    }
    const entry = cloudPut(path, bytes, device.id);
    device.seen.set(path, entry.version);
    broadcast(path, entry, device.id);
  }

  // The cloud keeps the existing file; the incoming one is stored under a new
  // name and goes to everyone including the writer, whose local original is
  // replaced by the cloud version.
  function storeConflictCopy(device, path, bytes, existing) {
    const copyPath = conflictCopyPath(path, device.id);
    const copy = cloudPut(copyPath, bytes, device.id);
    record("conflict", device.id, copyPath, bytes.length);
    broadcast(copyPath, copy, null);
    scheduleDownload(device.id, path, existing);
  }

  function applyDownload(event) {
    const device = devices.get(event.device);
    const { path } = event;
    if (event.op === "delete") {
      removeNode(device.tree, path);
      device.seen.delete(path);
      record("download", device.id, path, 0, "delete");
      return;
    }
    const node = { kind: "file", bytes: event.bytes, modifiedAt: now(), version: event.version };
    if (sim("readFailure").chance(config.readFailure.probability)) {
      node.unreadable = sim("readFailure").pick(["getFile", "arrayBuffer"]);
    }
    putFile(device.tree, path, node);
    device.seen.set(path, event.version);
    record("download", device.id, path, event.bytes.length);
    maybeMakePartial(device, path, node, event.bytes);
  }

  function maybeMakePartial(device, path, node, full) {
    const { probability, durationMs } = config.partialArrival;
    if (!sim("partial").chance(probability) || full.length < 2) return;
    const prefixLength = sim("partial").int(0, full.length - 1);
    node.bytes = full.slice(0, prefixLength);
    node.partial = true;
    record("fault", device.id, path, prefixLength, "partialArrival");
    const due = now() + drawLag(durationMs, "partial.duration");
    queue.push({ kind: "complete", device: device.id, path, node, full }, due, `done|${device.id}|${path}`);
  }

  function applyComplete(event) {
    const device = devices.get(event.device);
    if (getNode(device.tree, event.path) !== event.node) return; // superseded
    event.node.bytes = event.full;
    event.node.partial = false;
  }

  const HANDLERS = { upload: applyUpload, download: applyDownload, complete: applyComplete };

  function deliver(event) {
    const device = devices.get(event.device);
    if (device.online) HANDLERS[event.kind](event);
    else device.held.push(event);
  }

  function moveClockTo(time) {
    if (time > now()) clock.advance(time - now());
  }

  function drain(limit) {
    for (let event = queue.popDue(limit); event; event = queue.popDue(limit)) {
      moveClockTo(event.at);
      deliver(event);
    }
  }

  // ---- local operations (called by handles) ------------------------------

  function commitLocal(device, path, bytes) {
    putFile(device.tree, path, { kind: "file", bytes, modifiedAt: now(), version: 0 });
    totals.bytesWritten += bytes.length;
    device.counters.writes += 1;
    device.counters.bytesWritten += bytes.length;
    record("write", device.id, path, bytes.length);
    scheduleUpload(device.id, path, "put", bytes);
  }

  function dropSwap(device, swapPath) {
    const node = swapPath && getNode(device.tree, swapPath);
    if (node && node.transient) removeNode(device.tree, swapPath);
  }

  function leaveSwapBehind(device, swapPath, bytes) {
    putFile(device.tree, swapPath, { kind: "file", bytes, modifiedAt: now(), version: 0 });
    record("fault", device.id, swapPath, bytes.length, "crswapLeftBehind");
    scheduleUpload(device.id, swapPath, "put", bytes);
  }

  function injectJunk(device, dirPath) {
    const stream = sim("junk");
    if (!stream.chance(config.junk.probability)) return;
    const named = stream.pick(JUNK_NAMES);
    const name = named ?? `${[...stream.bytes(3)].map((b) => b.toString(16).padStart(2, "0")).join("")}.tmp`;
    const path = joinPath(dirPath, name);
    const bytes = stream.bytes(stream.int(0, MAX_JUNK_BYTES));
    putFile(device.tree, path, { kind: "file", bytes, modifiedAt: now(), version: 0 });
    record("fault", device.id, path, bytes.length, "junk");
    scheduleUpload(device.id, path, "put", bytes);
  }

  function createLocalOps(device) {
    return {
      createFile: (path) => commitLocal(device, path, EMPTY),
      removeFile(path) {
        const node = removeNode(device.tree, path);
        if (!node || node.transient) return;
        record("delete", device.id, path, node.bytes.length);
        scheduleUpload(device.id, path, "delete");
      },
      beginWrite(path) {
        if (!sim("crswap").chance(config.crswap.probability)) return null;
        const swapPath = `${path}.crswap`;
        if (getNode(device.tree, swapPath)) return null; // an earlier leftover is still there
        putFile(device.tree, swapPath, { kind: "file", bytes: EMPTY, modifiedAt: now(), transient: true });
        return swapPath;
      },
      finishWrite(path, swapPath, bytes) {
        dropSwap(device, swapPath);
        const node = getNode(device.tree, path);
        if (!node || node.kind !== "file") throw notFound(path);
        if (sim("writeFailure").chance(config.writeFailure.probability)) {
          record("fault", device.id, path, bytes.length, "writeFailure");
          throw fsError("NoModificationAllowedError", `cannot write ${path}`);
        }
        commitLocal(device, path, bytes);
        if (swapPath && sim("crswap").chance(config.crswap.leftBehindProbability)) {
          leaveSwapBehind(device, swapPath, bytes);
        }
        injectJunk(device, parentPath(path));
      },
      abortWrite: (swapPath) => dropSwap(device, swapPath),
      readFault(path, node, kind) {
        if (node.unreadable !== kind) return;
        node.unreadable = undefined;
        record("fault", device.id, path, node.bytes.length, "readFailure");
        throw fsError("NotReadableError", `cannot read ${path}`);
      },
      countRead(kind, size) {
        device.counters.reads += 1;
        if (kind === "arrayBuffer") {
          device.counters.bytesRead += size;
          device.counters.filesRead += 1;
        }
      },
    };
  }

  // ---- public API --------------------------------------------------------

  function requireDevice(id) {
    const device = devices.get(id);
    if (!device) throw new Error(`unknown device ${id}`);
    return device;
  }

  function addDevice(id) {
    if (devices.has(id)) throw new Error(`device ${id} already exists`);
    const device = {
      id,
      tree: createTree(),
      online: true,
      held: [],
      seen: new Map(),
      counters: { writes: 0, bytesWritten: 0, reads: 0, bytesRead: 0, filesRead: 0 },
    };
    device.ops = createLocalOps(device);
    device.root = createDirectoryHandle(device);
    devices.set(id, device);
    for (const path of [...cloud.keys()].sort()) scheduleDownload(id, path, cloud.get(path));
    return { id, root: device.root };
  }

  function releaseHeld(device) {
    for (const event of device.held.splice(0)) queue.requeue(event, now());
  }

  function setOnline(id, online) {
    const device = requireDevice(id);
    device.online = Boolean(online);
    if (device.online) releaseHeld(device);
  }

  async function advance(ms) {
    const target = now() + ms;
    drain(target);
    moveClockTo(target);
  }

  async function quiesce() {
    config = resolveFaults();
    for (const device of devices.values()) {
      device.online = true;
      releaseHeld(device);
    }
    drain(Infinity);
  }

  // Remove every file from the cloud and all views, and drop pending events.
  function wipeFolder() {
    cloud.clear();
    totals.cloudBytes = 0;
    queue.clear();
    for (const device of devices.values()) {
      device.tree = createTree();
      device.seen.clear();
      device.held.length = 0;
    }
    record("fault", null, "", 0, "wipeFolder");
  }

  // Simulates the user (not the engine) deleting a file in Explorer. Logged as
  // a "fault" so write/delete checks only see the engine's own actions.
  function removeLocalFile(id, path, { propagate = true } = {}) {
    const device = requireDevice(id);
    const node = removeNode(device.tree, path);
    if (!node) throw notFound(path);
    record("fault", id, path, node.bytes.length, propagate ? "removeLocalFile" : "removeLocalFileOnly");
    if (propagate) scheduleUpload(id, path, "delete");
  }

  const copyFiles = (entries) => new Map([...entries].map(([path, bytes]) => [path, bytes.slice()]));

  function stats() {
    const perDevice = {};
    for (const [id, device] of devices) perDevice[id] = { ...device.counters };
    return {
      cloudFiles: cloud.size,
      cloudBytes: totals.cloudBytes,
      peakCloudFiles: totals.peakCloudFiles,
      bytesWritten: totals.bytesWritten,
      bytesUploaded: totals.bytesUploaded,
      perDevice,
    };
  }

  function traceHash() {
    const hash = createHash("sha256");
    for (const e of log) hash.update(`${e.t}|${e.type}|${e.device}|${e.path}|${e.size}|${e.detail ?? ""}\n`);
    return hash.digest("hex");
  }

  return {
    clock,
    log,
    random: (name) => random.stream(name),
    addDevice,
    setOnline,
    advance,
    quiesce,
    setFaults: (overrides) => {
      config = resolveFaults(overrides);
    },
    wipeFolder,
    removeLocalFile,
    cloudFiles: () => copyFiles([...cloud].map(([path, entry]) => [path, entry.bytes])),
    cloudEntry: (path) => {
      const entry = cloud.get(path);
      return entry && { ...entry, bytes: entry.bytes.slice() };
    },
    deviceFiles: (id) => copyFiles([...walkFiles(requireDevice(id).tree)].map(([path, node]) => [path, node.bytes])),
    stats,
    traceHash,
  };
}
