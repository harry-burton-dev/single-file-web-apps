// The remembered passport file and workspace.json reads (OUT-11). The
// passport's file handle is the only identity value kept in IndexedDB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetPassport, loadPassport, pickPassport, readPassport, readWorkspaceFile, regrantPassport, savePassport } from "../../host/passport-file.ts";
import { memoryDb } from "../helpers/fake-browser.js";

function fileHandle(name, { text = "", permission = "granted" } = {}) {
  const handle = {
    kind: "file",
    name,
    text,
    permission,
    queryPermission: async () => handle.permission,
    requestPermission: async () => (handle.permission = "granted"),
    getFile: async () => ({ text: async () => handle.text }),
    createWritable: async () => {
      let written = "";
      return { write: async (data) => void (written += data), close: async () => void (handle.text = written) };
    },
  };
  return handle;
}

function withWindow(t, members) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: members, configurable: true, writable: true });
  t.after(() => (previous ? Object.defineProperty(globalThis, "window", previous) : delete globalThis.window));
}

const aborted = () => Promise.reject(new DOMException("cancelled", "AbortError"));

test("nothing remembered: status none", async () => {
  assert.deepEqual(await loadPassport(memoryDb()), { status: "none" });
});

test("save writes the passport where the user chose and remembers its handle", async (t) => {
  const chosen = fileHandle("sam.passport.json");
  let suggested;
  withWindow(t, { showSaveFilePicker: async (options) => ((suggested = options.suggestedName), chosen) });
  const db = memoryDb();
  const saved = await savePassport(db, { passportText: "{passport}", fileName: "sam.passport.json" });
  assert.equal(saved.status, "ready");
  assert.equal(suggested, "sam.passport.json");
  assert.equal(chosen.text, "{passport}");
  assert.equal((await loadPassport(db)).status, "ready");
  assert.equal(await readPassport(saved.handle), "{passport}");
});

test("cancelling the save picker remembers nothing", async (t) => {
  withWindow(t, { showSaveFilePicker: aborted });
  const db = memoryDb();
  assert.deepEqual(await savePassport(db, { passportText: "x", fileName: "sam.passport.json" }), { status: "none" });
  assert.deepEqual(await loadPassport(db), { status: "none" });
});

test("pick remembers an existing passport; cancelling remembers nothing", async (t) => {
  const existing = fileHandle("sam.passport.json", { text: "{old}" });
  let next = async () => [existing];
  withWindow(t, { showOpenFilePicker: () => next() });
  const db = memoryDb();
  assert.equal((await pickPassport(db)).status, "ready");
  assert.equal(await readPassport((await loadPassport(db)).handle), "{old}");
  await forgetPassport(db);
  next = aborted;
  assert.deepEqual(await pickPassport(db), { status: "none" });
  assert.deepEqual(await loadPassport(db), { status: "none" });
});

test("a lapsed permission is reported and can be granted again", async (t) => {
  const lapsed = fileHandle("sam.passport.json", { permission: "prompt" });
  withWindow(t, { showOpenFilePicker: async () => [lapsed] });
  const db = memoryDb();
  await pickPassport(db);
  const loaded = await loadPassport(db);
  assert.equal(loaded.status, "needs-permission");
  assert.equal((await regrantPassport(loaded.handle)).status, "ready");
});

test("the database holds the passport's handle and nothing else", async (t) => {
  withWindow(t, { showSaveFilePicker: async () => fileHandle("sam.passport.json") });
  const db = memoryDb();
  await savePassport(db, { passportText: "{passport}", fileName: "sam.passport.json" });
  const keys = await db.keys();
  assert.deepEqual(keys, ["host/passport-handle"]);
  assert.equal((await db.get(keys[0])).kind, "file");
});

test("workspace.json is read from the folder root, or null when there is none", async () => {
  const folder = (files) => ({
    getFileHandle: async (name) => {
      if (!(name in files)) throw new DOMException("missing", "NotFoundError");
      return fileHandle(name, { text: files[name] });
    },
  });
  assert.equal(await readWorkspaceFile(folder({ "workspace.json": '{"format":1}' })), '{"format":1}');
  assert.equal(await readWorkspaceFile(folder({})), null);
});
