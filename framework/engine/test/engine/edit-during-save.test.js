// An edit made while a save is in flight is not part of that save: it must
// stay pending afterwards and reach the folder (and a peer) with the next one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, json } from "./_harness.js";

const A = "harry-aaaaaaaa";
const S = "sam-bbbbbbbb";

/** Wraps the folder root so that closing a data file waits until release() is called. */
function gatedRoot(root) {
  const gate = { armed: false, reached: null, release: null };
  const wrapFile = (file, path) => ({
    kind: "file",
    name: file.name,
    getFile: () => file.getFile(),
    async createWritable() {
      const writable = await file.createWritable();
      return {
        write: (data) => writable.write(data),
        abort: () => writable.abort?.(),
        async close() {
          if (gate.armed && path.startsWith("data/")) {
            gate.armed = false;
            gate.reached();
            await gate.hold;
          }
          return writable.close();
        },
      };
    },
  });
  const wrapDir = (dir, prefix) => ({
    kind: "directory",
    name: dir.name,
    getDirectoryHandle: async (name, options) => wrapDir(await dir.getDirectoryHandle(name, options), `${prefix}${name}/`),
    getFileHandle: async (name, options) => wrapFile(await dir.getFileHandle(name, options), `${prefix}${name}`),
    removeEntry: (name, options) => dir.removeEntry(name, options),
    entries: async function* entries() {
      for await (const [name, child] of dir.entries()) yield [name, child.kind === "file" ? wrapFile(child, `${prefix}${name}`) : wrapDir(child, `${prefix}${name}/`)];
    },
  });
  return {
    root: wrapDir(root, ""),
    /** The next data write pauses at close(); resolves when it has got there. */
    arm() {
      const reached = new Promise((resolve) => {
        gate.reached = resolve;
      });
      gate.hold = new Promise((resolve) => {
        gate.release = resolve;
      });
      gate.armed = true;
      return reached;
    },
    release: () => gate.release(),
  };
}

test("an edit made while the save is writing stays pending and is saved and delivered later", async () => {
  const w = await makeWorld();
  const gated = gatedRoot(w.folder.root);
  const a = await w.device(A, { root: gated.root });
  const b = await w.device(S);
  a.table("notes").getMap("m").set("x", 1);
  w.clock.advance(3000); // quiet period over: a save is due
  const inFlight = gated.arm();
  const ticking = a.tick();
  await inFlight;
  a.table("notes").getMap("m").set("y", 2); // arrives while the write is pending
  gated.release();
  await ticking;
  assert.equal(a.status().pending, 1, "only the edit made during the save is still pending");
  await w.run([a, b], 15000);
  assert.equal(a.status().pending, 0);
  assert.deepEqual(json(b).m, { x: 1, y: 2 }, "the later edit reached the peer");
});
