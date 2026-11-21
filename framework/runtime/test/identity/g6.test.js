// Gate G6 (S3 acceptance): data is encrypted with a real workspace key that
// only invited users hold. Written before the code (plan section 4, OUT-8).
//
// The user side runs now, on a keyring made by hand. The two cases that need
// the admin operations are named placeholders; OUT-9 replaces them with real
// tests, written first. G6 is not ticked while any placeholder remains.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../../../engine/src/engine/engine.js";
import { createMemoryStore } from "../../../engine/src/store/memory.js";
import { yjsAdapter } from "../../../engine/src/adapters/yjs.js";
import { createMemFolder, createManualClock, createSeededRandom } from "../../../engine/test/helpers/memfolder.js";
import { EAGER, json } from "../../../engine/test/engine/_harness.js";
import { sealKeyFile, KeyFileError } from "../../identity/keyfile.js";
import { workspaceFileFor, WORKSPACE_FILE } from "../../identity/workspace.js";
import { enrol, unlock } from "../../identity/passport.js";
import { handMadeKeyring } from "./_keyring.js";

const ADMIN_PASS = "admin-chosen invite phrase";
const SAM_PASS = "sam's own passport phrase";
const KIM_PASS = "kim's own passport phrase";
const utf8 = (b) => new TextDecoder().decode(b);

/** A shared in-memory folder holding a workspace, and invites for Sam and Kim. */
async function workspace() {
  const clock = createManualClock();
  const folder = createMemFolder({ clock });
  const random = createSeededRandom(6);
  const keyring = handMadeKeyring(random);
  folder.drop(WORKSPACE_FILE, new TextEncoder().encode(await workspaceFileFor(keyring, { random })));
  const invite = (id, name) => sealKeyFile({ kind: "invite", payload: { ...keyring, user: { id, name } }, passphrase: ADMIN_PASS, random });
  return {
    folder, random,
    invites: { sam: await invite("sam", "Sam Smith"), kim: await invite("kim", "Kim Lee") },
    device: (deviceId, keyInput) =>
      createEngine({
        root: folder.root, clock, random, store: createMemoryStore(), deviceId, user: deviceId.split("-")[0],
        adapters: { yjs: yjsAdapter }, tables: { notes: "yjs" }, options: EAGER, ...keyInput,
      }),
    async run(engines, ms) {
      for (let t = 0; t < ms; t += 1000) {
        clock.advance(1000);
        for (const e of engines) await e.tick();
      }
    },
  };
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
  assert.deepEqual(sam.user, { id: "sam", name: "Sam Smith" });
  assert.deepEqual(kim.user, { id: "kim", name: "Kim Lee" });

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

test.todo("admin creates the workspace and writes users");
test.todo("after rotation, a user with only the old key reads old data but not new data");
