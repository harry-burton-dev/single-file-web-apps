// Gate G6 (S3 acceptance): data is encrypted with a real workspace key that
// only invited users hold. Written before the code (plan section 4, OUT-8).
//
// The admin side (OUT-9) makes the keyring, the invites and the users table;
// the user side (OUT-8) enrols and unlocks. The app screens (OUT-10, OUT-11)
// are smoke-tested separately.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createEngine } from "../../../engine/src/engine/engine.js";
import { openTable } from "../../../engine/src/records/index.js";
import { createMemoryStore } from "../../../engine/src/store/memory.js";
import { yjsAdapter } from "../../../engine/src/adapters/yjs.js";
import { createMemFolder, createManualClock, createSeededRandom } from "../../../engine/test/helpers/memfolder.js";
import { EAGER, json } from "../../../engine/test/engine/_harness.js";
import { KeyFileError } from "../../identity/keyfile.js";
import { workspaceFileFor, WORKSPACE_FILE } from "../../identity/workspace.js";
import { enrol, unlock, PassportError } from "../../identity/passport.js";
import {
  newKeyring, rotateKeyring, userIdFor, mintInvite, exportBackup, openBackup, engineKeys,
  USERS_TABLE, USERS_SCHEMA, putUser,
} from "../../identity/admin.js";

const ADMIN_PASS = "admin-chosen invite phrase";
const BACKUP_PASS = "the admin's backup phrase";
const SAM_PASS = "sam's own passport phrase";
const KIM_PASS = "kim's own passport phrase";
const utf8 = (b) => new TextDecoder().decode(b);

/**
 * A shared in-memory folder. The admin creates the workspace: a new keyring,
 * workspace.json, and invites for Sam and Kim. Engines read the users table
 * beside the app's notes, as the host runs them.
 */
async function workspace() {
  const clock = createManualClock();
  const folder = createMemFolder({ clock });
  const random = createSeededRandom(6);
  const w = {
    folder, random, clock,
    keyring: newKeyring({ random }),
    async publish() {
      folder.drop(WORKSPACE_FILE, new TextEncoder().encode(await workspaceFileFor(w.keyring, { random })));
    },
    async invite(name) {
      const id = userIdFor(name, []);
      return { id, text: await mintInvite({ keyring: w.keyring, user: { id, name }, passphrase: ADMIN_PASS, random }) };
    },
    device: (deviceId, keyInput) =>
      createEngine({
        root: folder.root, clock, random, store: createMemoryStore(), deviceId, user: deviceId.split("-")[0],
        adapters: { yjs: yjsAdapter }, tables: { notes: "yjs", [USERS_TABLE]: "yjs" }, options: EAGER, ...keyInput,
      }),
    users: (engine, deviceId) => openTable({ doc: engine.table(USERS_TABLE), schema: USERS_SCHEMA, deviceId, user: deviceId.split("-")[0], clock }),
    async run(engines, ms) {
      for (let t = 0; t < ms; t += 1000) {
        clock.advance(1000);
        for (const e of engines) await e.tick();
      }
    },
  };
  await w.publish();
  w.invites = { sam: (await w.invite("Sam")).text, kim: (await w.invite("Kim")).text };
  return w;
}

/** First run, then a launch: enrol from the invite and unlock the passport against the folder. */
async function enrolAndUnlock(w, inviteText, passphrase) {
  const { passportText } = await enrol({ inviteText, invitePassphrase: ADMIN_PASS, newPassphrase: passphrase, random: w.random });
  return unlock({ passportText, passphrase, workspaceText: utf8(w.folder.read(WORKSPACE_FILE)) });
}

test("two invited users enrol, unlock, write and read each other's edits", async () => {
  const w = await workspace();
  const sam = await enrolAndUnlock(w, w.invites.sam, SAM_PASS);
  const kim = await enrolAndUnlock(w, w.invites.kim, KIM_PASS);
  assert.deepEqual(sam.user, { id: "sam", name: "Sam" });
  assert.deepEqual(kim.user, { id: "kim", name: "Kim" });

  const a = await w.device("sam-aaaaaaaa", sam);
  const b = await w.device("kim-bbbbbbbb", kim);
  a.table("notes").getMap("m").set("from-sam", 1);
  b.table("notes").getMap("m").set("from-kim", 2);
  await w.run([a, b], 60000);

  assert.deepEqual(json(a), { m: { "from-sam": 1, "from-kim": 2 } });
  assert.deepEqual(json(b), json(a));
  assert.equal(a.status().unreadable.length, 0);
  assert.equal(b.status().unreadable.length, 0);
});

test("an outsider with folder access and a different key decrypts nothing", async () => {
  const w = await workspace();
  const sam = await enrolAndUnlock(w, w.invites.sam, SAM_PASS);
  const a = await w.device("sam-aaaaaaaa", sam);
  a.table("notes").getMap("m").set("secret", "quarterly plans");
  await w.run([a], 30000);
  const written = [...new Set(w.folder.writes.map((x) => x.path))];
  const sealed = written.filter((p) => p.endsWith(".ywb"));
  assert.ok(sealed.some((p) => p.startsWith("data/")) && sealed.some((p) => p.startsWith("status/")));

  const own = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const outsider = await w.device("eve-eeeeeeee", { key: own, keyId: 1 });
  await w.run([outsider], 10000);

  assert.deepEqual(json(outsider), {});
  const unreadable = new Set(outsider.status().unreadable.map((u) => u.path));
  for (const path of sealed) assert.ok(unreadable.has(path), `${path} should be unreadable to the outsider`);
  for (const path of written) assert.ok(!utf8(w.folder.read(path)).includes("quarterly plans"), `${path} holds the secret in the clear`);
});

test("a wrong passphrase is refused with a message", async () => {
  const w = await workspace();
  const wrong = "a guess at the phrase";
  const refused = (err) => {
    assert.ok(err instanceof KeyFileError);
    assert.equal(err.code, "wrong-passphrase");
    assert.equal(err.message, "That passphrase does not open this file.");
    return true;
  };
  await assert.rejects(enrol({ inviteText: w.invites.sam, invitePassphrase: wrong, newPassphrase: SAM_PASS, random: w.random }), refused);
  const { passportText } = await enrol({ inviteText: w.invites.sam, invitePassphrase: ADMIN_PASS, newPassphrase: SAM_PASS, random: w.random });
  await assert.rejects(unlock({ passportText, passphrase: wrong, workspaceText: utf8(w.folder.read(WORKSPACE_FILE)) }), refused);
});

test("admin creates the workspace and writes users", async () => {
  const w = await workspace();
  // Creating the workspace: the backup opens with its passphrase and matches the folder.
  const backup = await exportBackup({ keyring: w.keyring, passphrase: BACKUP_PASS, random: w.random });
  const reopened = await openBackup({ text: backup, passphrase: BACKUP_PASS });
  assert.deepEqual(reopened, w.keyring);

  const admin = await w.device("harry-adminaaa", await engineKeys(reopened));
  const users = w.users(admin, "harry-adminaaa");
  putUser(users, { id: userIdFor("Harry", []), name: "Harry", role: "admin", status: "active" });
  const taken = ["harry"];
  for (const name of ["Sam", "Kim"]) {
    const id = userIdFor(name, taken);
    taken.push(id);
    putUser(users, { id, name, role: "member", status: "active" });
  }
  await w.run([admin], 30000);

  // An invited user sees the users table, written under the workspace key.
  const sam = await enrolAndUnlock(w, w.invites.sam, SAM_PASS);
  const a = await w.device("sam-aaaaaaaa", sam);
  await w.run([a, admin], 10000);
  const seen = () => Object.fromEntries(w.users(a, "sam-aaaaaaaa").list().map((r) => [r.id, r.fields]));
  assert.deepEqual(seen(), {
    harry: { name: "Harry", role: "admin", status: "active" },
    kim: { name: "Kim", role: "member", status: "active" },
    sam: { name: "Sam", role: "member", status: "active" },
  });

  // Removing Kim marks her inactive. It does not rotate the key.
  putUser(users, { id: "kim", name: "Kim", role: "member", status: "inactive" });
  await w.run([admin, a], 30000);
  assert.equal(seen().kim.status, "inactive");
  assert.deepEqual(reopened.keys.map((k) => k.id), [1]);
  assert.equal(a.status().unreadable.length, 0);
});

test("after rotation, a user with only the old key reads old data but not new data", async () => {
  const w = await workspace();
  const sam = await enrolAndUnlock(w, w.invites.sam, SAM_PASS);
  const { passportText: samPassport } = await enrol({ inviteText: w.invites.sam, invitePassphrase: ADMIN_PASS, newPassphrase: SAM_PASS, random: w.random });
  const a = await w.device("sam-aaaaaaaa", sam);
  a.table("notes").getMap("m").set("old", "before rotation");
  await w.run([a], 30000);

  // The admin rotates, rewrites workspace.json, and re-invites Kim with every key.
  w.keyring = rotateKeyring(w.keyring, { random: w.random });
  await w.publish();
  const kimInvite = await w.invite("Kim");
  const kim = await enrolAndUnlock(w, kimInvite.text, KIM_PASS);
  assert.equal(kim.keyId, 2);
  const b = await w.device("kim-bbbbbbbb", kim);
  await w.run([b], 10000);
  assert.deepEqual(json(b), { m: { old: "before rotation" } }, "the new key's holder reads data from before the rotation");
  b.table("notes").getMap("m").set("new", "after rotation");
  await w.run([b], 30000);

  // Sam's engine still holds only key 1: the old note, nothing new, and Kim's files unreadable.
  const before = a.status().unreadable.length;
  await w.run([a], 10000);
  assert.deepEqual(json(a), { m: { old: "before rotation" } });
  assert.ok(a.status().unreadable.length > before, "Kim's key-2 files are unreadable to Sam");
  assert.ok(a.status().unreadable.every((u) => u.path.includes("kim-bbbbbbbb")));

  // And Sam's passport is refused at the next launch until Sam enrols again.
  await assert.rejects(
    unlock({ passportText: samPassport, passphrase: SAM_PASS, workspaceText: utf8(w.folder.read(WORKSPACE_FILE)) }),
    (err) => err instanceof PassportError && err.code === "out-of-date",
  );
});
