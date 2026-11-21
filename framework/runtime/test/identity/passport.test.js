// Passports (plan 3.7): enrol once from the admin's invite, unlock on every
// launch. Keys are held in memory only, as non-extractable CryptoKeys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeededRandom } from "../../../engine/test/helpers/memfolder.js";
import { sealKeyFile, openKeyFile, KeyFileError } from "../../identity/keyfile.js";
import { workspaceFileFor } from "../../identity/workspace.js";
import { enrol, unlock, PassportError } from "../../identity/passport.js";
import { newKeyring, rotateKeyring } from "../../identity/admin.js";

const random = createSeededRandom(21);
const ADMIN_PASS = "the admin's one-time phrase";
const OWN_PASS = "my very own passport phrase";
const user = { id: "sam", name: "Sam Smith" };

/** A workspace with keys 1 to `keyCount`, and an invite for Sam. */
async function invited(keyCount = 1) {
  let keyring = newKeyring({ random });
  while (keyring.keys.length < keyCount) keyring = rotateKeyring(keyring, { random });
  const inviteText = await sealKeyFile({ kind: "invite", payload: { ...keyring, user }, passphrase: ADMIN_PASS, random });
  return { keyring, inviteText, workspaceText: await workspaceFileFor(keyring, { random }) };
}

const rejectsWith = (promise, Type, code, message) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof Type, `expected ${Type.name}, got ${err}`);
    assert.equal(err.code, code);
    if (message) assert.equal(err.message, message);
    return true;
  });

test("enrol turns the invite into a passport under the user's own passphrase", async () => {
  const { keyring, inviteText } = await invited(2);
  const { passportText, fileName, user: who } = await enrol({ inviteText, invitePassphrase: ADMIN_PASS, newPassphrase: OWN_PASS, random });
  assert.equal(fileName, "sam.passport.json");
  assert.deepEqual(who, user);
  assert.equal(JSON.parse(passportText).kind, "passport");
  assert.deepEqual(await openKeyFile({ text: passportText, passphrase: OWN_PASS, kind: "passport" }), { ...keyring, user });
  // The admin's passphrase does not open the passport.
  await rejectsWith(openKeyFile({ text: passportText, passphrase: ADMIN_PASS, kind: "passport" }), KeyFileError, "wrong-passphrase");
});

test("enrol refuses a wrong invite passphrase and a weak new one", async () => {
  const { inviteText } = await invited();
  await rejectsWith(enrol({ inviteText, invitePassphrase: "not the admin phrase", newPassphrase: OWN_PASS, random }), KeyFileError, "wrong-passphrase");
  await rejectsWith(enrol({ inviteText, invitePassphrase: ADMIN_PASS, newPassphrase: "too short", random }), KeyFileError, "weak-passphrase");
});

test("unlock gives the user and non-extractable keys, writing with the current key", async () => {
  const { inviteText, workspaceText } = await invited(2);
  const { passportText } = await enrol({ inviteText, invitePassphrase: ADMIN_PASS, newPassphrase: OWN_PASS, random });
  const id = await unlock({ passportText, passphrase: OWN_PASS, workspaceText });
  assert.deepEqual(id.user, user);
  assert.equal(id.keyId, 2);
  assert.deepEqual([...id.keys.keys()], [1, 2]);
  assert.equal(id.key, id.keys.get(2));
  for (const key of id.keys.values()) {
    assert.ok(key instanceof CryptoKey);
    assert.equal(key.extractable, false);
    assert.equal(key.algorithm.name, "AES-GCM");
  }
  await assert.rejects(crypto.subtle.exportKey("raw", id.key));
});

test("unlock refuses a wrong passphrase with the key file message", async () => {
  const { inviteText, workspaceText } = await invited();
  const { passportText } = await enrol({ inviteText, invitePassphrase: ADMIN_PASS, newPassphrase: OWN_PASS, random });
  await rejectsWith(unlock({ passportText, passphrase: "a guess at my phrase", workspaceText }), KeyFileError, "wrong-passphrase", "That passphrase does not open this file.");
  // An invite is not a passport.
  await rejectsWith(unlock({ passportText: inviteText, passphrase: ADMIN_PASS, workspaceText }), KeyFileError, "wrong-kind");
});

test("unlock refuses a passport for a different workspace", async () => {
  const { inviteText } = await invited();
  const other = await invited();
  const { passportText } = await enrol({ inviteText, invitePassphrase: ADMIN_PASS, newPassphrase: OWN_PASS, random });
  await rejectsWith(unlock({ passportText, passphrase: OWN_PASS, workspaceText: other.workspaceText }), PassportError, "other-workspace", "This passport is for a different workspace.");
});

test("unlock refuses an out-of-date passport after a rotation", async () => {
  const { keyring, inviteText } = await invited(1);
  const { passportText } = await enrol({ inviteText, invitePassphrase: ADMIN_PASS, newPassphrase: OWN_PASS, random });
  const rotated = { ...keyring, current: 2, keys: [...keyring.keys, { id: 2, raw: random.bytes(32) }] };
  const workspaceText = await workspaceFileFor(rotated, { random });
  await rejectsWith(unlock({ passportText, passphrase: OWN_PASS, workspaceText }), PassportError, "out-of-date", "Your passport is out of date. Ask the admin for a new invite.");
});

test("unlock refuses a folder with no workspace, or a damaged workspace file", async () => {
  const { inviteText } = await invited();
  const { passportText } = await enrol({ inviteText, invitePassphrase: ADMIN_PASS, newPassphrase: OWN_PASS, random });
  await rejectsWith(unlock({ passportText, passphrase: OWN_PASS, workspaceText: null }), PassportError, "no-workspace", "This folder has no workspace yet. Ask the admin to create one.");
  await rejectsWith(unlock({ passportText, passphrase: OWN_PASS, workspaceText: "{ damaged" }), PassportError, "bad-workspace", "The workspace file in this folder is damaged. Ask the admin to check it.");
});
