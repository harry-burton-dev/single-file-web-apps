// Admin operations with no screen (plan 3.9, OUT-9): keyrings, rotation,
// user ids, invites, key backups, engine keys and the users table.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createManualClock, createSeededRandom } from "../../../engine/test/helpers/memfolder.js";
import { openTable } from "../../../engine/src/records/index.js";
import { openKeyFile, KeyFileError } from "../../identity/keyfile.js";
import { workspaceFileFor, checkKeyring } from "../../identity/workspace.js";
import {
  newKeyring, rotateKeyring, userIdFor, mintInvite, exportBackup, openBackup, engineKeys,
  USERS_TABLE, USERS_SCHEMA, putUser,
} from "../../identity/admin.js";

const random = createSeededRandom(9);
const PASS = "the admin's backup phrase";

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof KeyFileError, `expected KeyFileError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });

test("newKeyring makes a workspace id and key 1", () => {
  const a = newKeyring({ random });
  const b = newKeyring({ random });
  assert.match(a.workspace, /^[a-z0-9]{16}$/);
  assert.notEqual(a.workspace, b.workspace);
  assert.equal(a.current, 1);
  assert.equal(a.keys.length, 1);
  assert.equal(a.keys[0].id, 1);
  assert.ok(a.keys[0].raw instanceof Uint8Array && a.keys[0].raw.length === 32);
  assert.notDeepEqual(a.keys[0].raw, b.keys[0].raw);
});

test("rotateKeyring adds the next key id and leaves the old keyring alone", () => {
  const one = newKeyring({ random });
  const two = rotateKeyring(one, { random });
  assert.equal(two.workspace, one.workspace);
  assert.equal(two.current, 2);
  assert.deepEqual(two.keys.map((k) => k.id), [1, 2]);
  assert.deepEqual(two.keys[0].raw, one.keys[0].raw);
  assert.notDeepEqual(two.keys[1].raw, one.keys[0].raw);
  assert.equal(one.current, 1);
  assert.equal(one.keys.length, 1);
  // The new keyring holds its own copies, so zeroing one does not zero the other.
  two.keys[0].raw.fill(0);
  assert.notDeepEqual(one.keys[0].raw, new Uint8Array(32));
});

test("rotateKeyring counts from the highest id and refuses to go past 255", () => {
  const ring = newKeyring({ random });
  const gappy = { ...ring, current: 7, keys: [ring.keys[0], { id: 7, raw: random.bytes(32) }] };
  assert.equal(rotateKeyring(gappy, { random }).current, 8);
  const full = { ...ring, current: 255, keys: [{ id: 255, raw: random.bytes(32) }] };
  assert.throws(() => rotateKeyring(full, { random }), /255/);
});

test("userIdFor makes a short lower-case id from the name", () => {
  assert.equal(userIdFor("Sam Smith", []), "samsmith");
  assert.equal(userIdFor("  José O'Brien-Núñez ", []), "joseobriennunez");
  assert.equal(userIdFor("Alexandra Montgomery-Wellington", []), "alexandramontgom");
  assert.equal(userIdFor("2nd Shift Lead", []), "ndshiftlead");
  assert.equal(userIdFor("Al", []), "al");
  for (const name of ["Al", "A", "", "  ", "李小龍", "007"]) assert.match(userIdFor(name, []), /^[a-z][a-z0-9]{1,15}$/, name);
});

test("userIdFor adds a digit suffix when the id is taken, staying within 16 characters", () => {
  assert.equal(userIdFor("Sam Smith", ["samsmith"]), "samsmith2");
  assert.equal(userIdFor("Sam Smith", new Set(["samsmith", "samsmith2"])), "samsmith3");
  assert.equal(userIdFor("Alexandra Montgomery", ["alexandramontgom"]), "alexandramontgo2");
  const taken = ["user"];
  assert.equal(userIdFor("", taken), "user2");
});

test("mintInvite seals every key and the user as an invite", async () => {
  const ring = rotateKeyring(newKeyring({ random }), { random });
  const user = { id: "sam", name: "Sam Smith" };
  const text = await mintInvite({ keyring: ring, user, passphrase: "a one-time invite phrase", random });
  assert.equal(JSON.parse(text).kind, "invite");
  assert.deepEqual(await openKeyFile({ text, passphrase: "a one-time invite phrase", kind: "invite" }), { ...ring, user });
  await rejectsWith(mintInvite({ keyring: ring, user, passphrase: "too short", random }), "weak-passphrase");
  await rejectsWith(mintInvite({ keyring: ring, user: { id: "Sam!", name: "Sam" }, passphrase: "a one-time invite phrase", random }), "bad-file");
});

test("exportBackup and openBackup round-trip the keyring", async () => {
  const ring = rotateKeyring(newKeyring({ random }), { random });
  const text = await exportBackup({ keyring: ring, passphrase: PASS, random });
  assert.equal(JSON.parse(text).kind, "key-backup");
  const back = await openBackup({ text, passphrase: PASS });
  assert.deepEqual(back, ring);
  assert.equal(await checkKeyring(back, await workspaceFileFor(ring, { random })), "ok");
});

test("a backup never carries a user, even from a keyring that has one", async () => {
  const ring = { ...newKeyring({ random }), user: { id: "sam", name: "Sam" } };
  const back = await openBackup({ text: await exportBackup({ keyring: ring, passphrase: PASS, random }), passphrase: PASS });
  assert.equal("user" in back, false);
});

test("openBackup refuses a wrong passphrase, an invite, and junk", async () => {
  const ring = newKeyring({ random });
  const text = await exportBackup({ keyring: ring, passphrase: PASS, random });
  await rejectsWith(openBackup({ text, passphrase: "not the backup phrase" }), "wrong-passphrase");
  const invite = await mintInvite({ keyring: ring, user: { id: "sam", name: "Sam" }, passphrase: PASS, random });
  await rejectsWith(openBackup({ text: invite, passphrase: PASS }), "wrong-kind");
  await rejectsWith(openBackup({ text: "not json", passphrase: PASS }), "bad-file");
  await rejectsWith(exportBackup({ keyring: ring, passphrase: "short", random }), "weak-passphrase");
});

test("engineKeys imports every key, non-extractable, writing with the current one", async () => {
  const ring = rotateKeyring(newKeyring({ random }), { random });
  const { key, keyId, keys } = await engineKeys(ring);
  assert.equal(keyId, 2);
  assert.deepEqual([...keys.keys()], [1, 2]);
  assert.equal(keys.get(2), key);
  for (const k of keys.values()) {
    assert.ok(k instanceof CryptoKey);
    assert.equal(k.extractable, false);
  }
  // The admin keeps using the keyring, so its raw bytes are left as they were.
  assert.notDeepEqual(ring.keys[0].raw, new Uint8Array(32));
});

function usersTable() {
  return openTable({ doc: new Y.Doc(), schema: USERS_SCHEMA, deviceId: "admin-aaaaaaaa", user: "admin", clock: createManualClock() });
}

test("putUser writes a users record; removing a user marks them inactive", () => {
  assert.equal(USERS_TABLE, "users");
  const table = usersTable();
  putUser(table, { id: "harry", name: "Harry", role: "admin", status: "active" });
  putUser(table, { id: "sam", name: "Sam Smith", role: "member", status: "active" });
  putUser(table, { id: "sam", name: "Sam Smith", role: "member", status: "inactive" });
  assert.deepEqual(
    table.list().map((r) => ({ id: r.id, ...r.fields })),
    [
      { id: "harry", name: "Harry", role: "admin", status: "active" },
      { id: "sam", name: "Sam Smith", role: "member", status: "inactive" },
    ],
  );
  assert.equal(table.get("sam").deleted, false);
});

test("putUser refuses bad ids, names, roles and statuses", () => {
  const table = usersTable();
  const ok = { id: "sam", name: "Sam", role: "member", status: "active" };
  for (const bad of [
    { ...ok, id: "Sam" }, { ...ok, id: "s" }, { ...ok, name: " " }, { ...ok, name: 3 },
    { ...ok, role: "owner" }, { ...ok, status: "removed" }, { ...ok, status: undefined },
  ]) assert.throws(() => putUser(table, bad), TypeError, JSON.stringify(bad));
  assert.deepEqual(table.list(), []);
});
