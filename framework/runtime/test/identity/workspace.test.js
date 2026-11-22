// workspace.json (plan 3.4): a public file at the root of the shared folder
// that matches a keyring to its workspace. It holds no secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeededRandom } from "../../../engine/test/helpers/memfolder.js";
import { workspaceFileFor, checkKeyring, WORKSPACE_FILE } from "../../identity/workspace.js";
import { newKeyring, rotateKeyring } from "../../identity/admin.js";

const random = createSeededRandom(11);
const b64len = (s) => atob(s).length;

test("the file lists the workspace id and one check per key id, and no key material", async () => {
  const keyring = rotateKeyring(newKeyring({ random }), { random });
  const text = await workspaceFileFor(keyring, { random });
  assert.equal(WORKSPACE_FILE, "workspace.json");
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, 1);
  assert.equal(parsed.id, keyring.workspace);
  assert.deepEqual(Object.keys(parsed.checks), ["1", "2"]);
  for (const c of Object.values(parsed.checks)) {
    assert.equal(b64len(c.iv), 12);
    assert.equal(b64len(c.data), 16 + 16); // 16-character id plus the GCM tag
  }
  for (const k of keyring.keys) assert.ok(!text.includes(btoa(String.fromCharCode(...k.raw))));
});

test("ok: the keyring holds every key the workspace has issued", async () => {
  const keyring = rotateKeyring(newKeyring({ random }), { random });
  assert.equal(await checkKeyring(keyring, await workspaceFileFor(keyring, { random })), "ok");
});

test("out-of-date: after a rotation the keyring lacks the new key", async () => {
  const rotated = rotateKeyring(newKeyring({ random }), { random });
  const old = { ...rotated, current: 1, keys: rotated.keys.filter((k) => k.id === 1) };
  assert.equal(await checkKeyring(old, await workspaceFileFor(rotated, { random })), "out-of-date");
});

test("other-workspace: the ids differ, or a key does not open its check", async () => {
  const ours = newKeyring({ random });
  const text = await workspaceFileFor(ours, { random });
  assert.equal(await checkKeyring(newKeyring({ random }), text), "other-workspace");
  // A forged keyring claiming our id but holding another key 1.
  const forged = { ...newKeyring({ random }), workspace: ours.workspace };
  assert.equal(await checkKeyring(forged, text), "other-workspace");
  // A key id this workspace never issued.
  const extra = { ...ours, current: 2, keys: [...ours.keys, { id: 2, raw: random.bytes(32) }] };
  assert.equal(await checkKeyring(extra, text), "other-workspace");
});

test("bad-file: anything that is not a format 1 workspace file", async () => {
  const keyring = newKeyring({ random });
  const good = JSON.parse(await workspaceFileFor(keyring, { random }));
  const bad = [
    "", "not json", "[]", "{}",
    JSON.stringify({ ...good, format: 2 }),
    JSON.stringify({ ...good, checks: {} }),
    JSON.stringify({ ...good, checks: { 1: { iv: "!!", data: good.checks[1].data } } }),
    JSON.stringify({ ...good, checks: { x: good.checks[1] } }),
  ];
  for (const text of bad) assert.equal(await checkKeyring(keyring, text), "bad-file", text);
});
