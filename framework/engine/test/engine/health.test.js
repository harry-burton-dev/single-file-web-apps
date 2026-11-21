import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./_harness.js";

const A = "harry-aaaaaaaa";
const B = "sam-bbbbbbbb";
const MIN = 60 * 1000;
const edit = (e, k, v = 1) => e.table("notes").getMap("m").set(k, v);
const named = (name, message = name) => Object.assign(new Error(message), { name });

/** Wrap a folder so that directories matching `hidden` do not show up in listings (for this device only). */
function blind(dir, hidden, path = "") {
  return new Proxy(dir, {
    get(target, prop) {
      if (prop === "getDirectoryHandle") {
        return async (name, options) => blind(await target.getDirectoryHandle(name, options), hidden, path ? `${path}/${name}` : name);
      }
      if (prop === "entries") {
        return async function* entries() {
          for await (const [name, handle] of target.entries()) {
            const child = path ? `${path}/${name}` : name;
            if (hidden(child)) continue;
            yield [name, handle.kind === "directory" ? blind(handle, hidden, child) : handle];
          }
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("a fresh engine is saved; an edit makes it saving; saving it makes it saved again", async () => {
  const w = await makeWorld({ options: { quietMs: 30000, maxWaitMs: 180000, minIntervalMs: 30000 } });
  const a = await w.device(A);
  const events = [];
  a.on("health", (e) => events.push(e.state));
  let h = a.health();
  assert.deepEqual([h.state, h.pending, h.since], ["saved", 0, w.clock.now()]);
  assert.equal(h.nextSaveAt, null);
  w.clock.advance(1000);
  edit(a, "x");
  h = a.health();
  assert.equal(h.state, "saving");
  assert.equal(h.pending, 1);
  assert.equal(h.since, w.clock.now());
  assert.equal(h.nextSaveAt, w.clock.now() + 30000);
  assert.match(h.detail, /1 change/);
  await a.flush();
  h = a.health();
  assert.deepEqual([h.state, h.pending, h.lastSaveAt], ["saved", 0, w.clock.now()]);
  assert.deepEqual(events, ["saving", "saved"], "an event per change of state, none otherwise");
  assert.ok(h.lastScanAt > 0);
});

test("a failing save is retrying until the folder accepts it", async () => {
  const w = await makeWorld({ options: { retryInitialMs: 10000 } });
  const a = await w.device(A);
  const events = [];
  a.on("health", (e) => events.push(e.state));
  w.folder.failWrites((p) => p.startsWith("data/"));
  edit(a, "x");
  await w.run([a], 3000);
  const h = a.health();
  assert.equal(h.state, "retrying");
  assert.equal(h.pending, 1);
  assert.equal(h.retryAt, a.status().retryAt);
  w.folder.clearFailures();
  await w.run([a], 15000);
  assert.equal(a.health().state, "saved");
  assert.deepEqual(events, ["saving", "retrying", "saved"]);
});

test("offline is whatever the host says, and wins over everything", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  const events = [];
  a.on("health", (e) => events.push(e.state));
  a.setOffline(true);
  assert.equal(a.health().state, "offline");
  edit(a, "x");
  await w.run([a], 5000);
  assert.equal(a.health().state, "offline", "saves still happen, the state follows the hint");
  assert.equal(a.health().pending, 0);
  a.setOffline(false);
  assert.equal(a.health().state, "saved");
  assert.deepEqual(events, ["offline", "saved"]);
});

test("folder-disconnected: the root cannot be listed (changes stay pending, and are saved on return)", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  w.folder.failListing((p) => p === "", named("NotAllowedError"));
  await w.run([a], 2000);
  assert.equal(a.health().state, "folder-disconnected");
  assert.equal(a.traces({ kind: "scan" })[0].outcome, "failed");
  edit(a, "x");
  assert.equal(a.health().state, "folder-disconnected", "still disconnected, even with changes waiting");
  assert.equal(a.status().pending >= 0, true);
  w.folder.clearListing();
  await w.run([a], 5000);
  const h = a.health();
  assert.equal(h.state, "saved");
  assert.equal(w.folder.paths("data/notes/harry-aaaaaaaa/").length, 1, "the change reached the folder");
});

test("folder-disconnected: a root that vanished, and a permission lapse during a write", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  w.folder.failListing((p) => p === "", named("NotFoundError"));
  await w.run([a], 2000);
  assert.equal(a.health().state, "folder-disconnected");
  w.folder.clearListing();
  await w.run([a], 2000);
  assert.equal(a.health().state, "saved");

  w.folder.failWrites(() => true, named("NotAllowedError")); // a lapsed permission fails every write, status files too
  edit(a, "x");
  await w.run([a], 3000);
  assert.equal(a.health().state, "folder-disconnected", "an access error outranks retrying");
  assert.ok(a.health().detail.includes("NotAllowedError"));
  assert.equal(a.status().pending, 1);
  w.folder.clearFailures();
  await w.run([a], 20000);
  assert.equal(a.health().state, "saved");
});

test("ordinary write failures are retrying, not disconnected", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  w.folder.failWrites((p) => p.startsWith("data/"));
  edit(a, "x");
  await w.run([a], 3000);
  assert.equal(a.health().state, "retrying");
});

// Two devices where B never sees A's files (its listings hide them) but keeps
// writing its status file, so A sees an active peer that never acknowledges.
async function deafPeer({ hideFromB = true } = {}) {
  const w = await makeWorld();
  const a = await w.device(A);
  const hidden = (p) => hideFromB && p.startsWith(`data/notes/${A}`);
  const b = await w.device(B, { root: blind(w.folder.root, hidden) });
  return { w, a, b };
}

test("not-reaching-peers: only after an active peer has not acknowledged for ackTimeoutMs", async () => {
  const { w, a, b } = await deafPeer();
  await w.run([a, b], 10000);
  assert.equal(a.health().state, "saved");
  edit(a, "x");
  await w.run([a, b], 10000);
  const wroteAt = a.traces({ kind: "save", outcome: "ok" })[0].startedAt;
  assert.equal(a.health().state, "saved");
  const p = a.health().peers[B];
  assert.deepEqual([p.active, p.ackedLatest, p.lastAckedAt], [true, false, null]);
  assert.equal(p.waitingSince, wroteAt);

  const events = [];
  a.on("health", (e) => events.push(e.state));
  while (w.clock.now() + 5000 <= wroteAt + 10 * MIN) await w.run([a, b], 5000, 5000);
  assert.equal(a.health().state, "saved");
  // exactly at the timeout it is not yet "longer than"; one millisecond later it is
  w.clock.set(wroteAt + 10 * MIN);
  await b.tick();
  await a.tick();
  assert.equal(a.health().state, "saved", "10 minutes exactly is not longer than 10 minutes");
  w.clock.set(wroteAt + 10 * MIN + 1);
  await b.tick();
  await a.tick();
  assert.equal(a.health().state, "not-reaching-peers");
  assert.match(a.health().detail, /acknowledged/);
  assert.deepEqual(events, ["not-reaching-peers"]);
});

test("not-reaching-peers is left when the peer acknowledges", async () => {
  const w = await makeWorld();
  let blindToA = true;
  const a = await w.device(A);
  const b = await w.device(B, { root: blind(w.folder.root, (p) => blindToA && p.startsWith(`data/notes/${A}`)) });
  edit(a, "x");
  await w.run([a, b], 11 * MIN, 5000);
  assert.equal(a.health().state, "not-reaching-peers");
  blindToA = false;
  await w.run([a, b], 30000, 5000);
  assert.equal(a.health().state, "saved");
  assert.ok(a.health().peers[B].lastAckedAt > 0);
  assert.equal(a.health().peers[B].ackedLatest, true);
});

test("a peer that stops being active is no longer waited for", async () => {
  const { w, a, b } = await deafPeer();
  edit(a, "x");
  await w.run([a, b], 11 * MIN, 5000);
  assert.equal(a.health().state, "not-reaching-peers");
  const lastHeard = a.health().peers[B].lastHeardAt;
  await w.run([a], 20 * MIN, 30000); // only A ticks: B has gone away
  const h = a.health();
  assert.equal(w.clock.now() - lastHeard > 15 * MIN, true);
  assert.equal(h.peers[B].active, false);
  assert.equal(h.state, "saved", "nobody active, nothing to report");
});

test("never reported with no active peer, however long we run", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  edit(a, "x");
  await w.run([a], 40 * MIN, 30000);
  assert.deepEqual(a.health().peers, {});
  assert.equal(a.health().state, "saved");
});

test("not reported while changes are pending, or while saves fail", async () => {
  const { w, a, b } = await deafPeer();
  edit(a, "x");
  await w.run([a, b], 11 * MIN, 5000);
  assert.equal(a.health().state, "not-reaching-peers");
  edit(a, "y");
  assert.equal(a.health().state, "saving");
  w.folder.failWrites((p) => p.startsWith("data/"));
  await w.run([a, b], 20000, 5000);
  assert.equal(a.health().state, "retrying");
});

test("the thresholds are options", async () => {
  const w = await makeWorld({ options: { health: { peerActiveWindowMs: 5 * MIN, ackTimeoutMs: 2 * MIN } } });
  const a = await w.device(A);
  const b = await w.device(B, { root: blind(w.folder.root, (p) => p.startsWith(`data/notes/${A}`)) });
  edit(a, "x");
  await w.run([a, b], 3 * MIN, 5000);
  assert.equal(a.health().state, "not-reaching-peers");
});

test("health judges a colleague by when this device last saw them, not by the colleague's clock", async () => {
  const DAY = 24 * 60 * MIN;
  const w = await makeWorld();
  const a = await w.device(A);
  const behind = await w.device(B, { clock: { now: () => w.clock.now() - 40 * DAY } });
  for (let i = 0; i < 5; i++) {
    edit(behind, `b${i}`, i);
    await w.run([a, behind], 10000);
  }
  let p = a.health().peers[B];
  assert.equal(p.active, true, "a colleague 40 days behind who is writing now is active");
  assert.ok(w.clock.now() - p.lastHeardAt <= 10000, "last heard is on this device's clock");

  const C = "kim-cccccccc";
  const ahead = await w.device(C, { clock: { now: () => w.clock.now() + 2 * DAY } });
  edit(ahead, "c", 1);
  await w.run([a, ahead], 10000);
  assert.equal(a.health().peers[C].active, true);
  await w.run([a], 20 * MIN, 30000); // only A ticks: both colleagues fall silent
  p = a.health().peers[C];
  assert.equal(p.active, false, "a colleague whose clock is ahead and who has been silent past the window is not active");
  assert.ok(w.clock.now() - p.lastHeardAt > 15 * MIN);
});
