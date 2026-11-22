// The admin page's folder and key file steps (OUT-10), without the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemFolder, createSeededRandom } from "../../../engine/test/helpers/memfolder.js";
import { KeyFileError } from "../../identity/keyfile.js";
import { workspaceFileFor, WORKSPACE_FILE } from "../../identity/workspace.js";
import { enrol } from "../../identity/passport.js";
import { newKeyring, rotateKeyring, mintInvite, exportBackup } from "../../identity/admin.js";
import { readWorkspace, writeWorkspace, openKeyring, AdminError, backupFileName, inviteFileName } from "../../admin/actions.js";

const PASS = "the admin's backup phrase";

test("readWorkspace: missing, found, and written back", async () => {
  const folder = createMemFolder();
  assert.deepEqual(await readWorkspace(folder.root), { status: "missing" });
  await writeWorkspace(folder.root, "{\"format\":1}");
  assert.deepEqual(await readWorkspace(folder.root), { status: "found", text: "{\"format\":1}" });
  assert.equal(new TextDecoder().decode(folder.read(WORKSPACE_FILE)), "{\"format\":1}");
});

test("readWorkspace: a file that cannot be read is reported, not thrown", async () => {
  const root = { getFileHandle: async () => ({ getFile: async () => { throw Object.assign(new Error("locked"), { name: "NotReadableError" }); } }) };
  assert.deepEqual(await readWorkspace(root), { status: "unreadable", message: "NotReadableError: locked" });
});

test("openKeyring opens a backup that matches the folder", async () => {
  const random = createSeededRandom(1);
  const keyring = newKeyring({ random });
  const text = await exportBackup({ keyring, passphrase: PASS, random });
  const opened = await openKeyring({ text, passphrase: PASS, workspaceText: await workspaceFileFor(keyring, { random }) });
  assert.deepEqual(opened, { keyring, from: "key-backup" });
});

test("openKeyring refuses a backup for another workspace, an out-of-date one, and a damaged workspace.json", async () => {
  const random = createSeededRandom(2);
  const keyring = newKeyring({ random });
  const text = await exportBackup({ keyring, passphrase: PASS, random });
  const refused = (code, message) => (err) => err instanceof AdminError && err.code === code && err.message === message;

  const other = await workspaceFileFor(newKeyring({ random }), { random });
  await assert.rejects(openKeyring({ text, passphrase: PASS, workspaceText: other }), refused("other-workspace", "This key file is for a different workspace."));

  const rotated = await workspaceFileFor(rotateKeyring(keyring, { random }), { random });
  await assert.rejects(openKeyring({ text, passphrase: PASS, workspaceText: rotated }), refused("out-of-date", "This key file is out of date: the workspace has a newer key. Use the latest key backup."));

  const err = await openKeyring({ text, passphrase: PASS, workspaceText: "not json" }).catch((e) => e);
  assert.ok(refused("bad-workspace", "The workspace file in this folder is damaged. You can rewrite it from this key file.")(err));
  assert.deepEqual(err.keyring, keyring, "the opened keyring comes with the error, so the page can offer the repair");
});

test("openKeyring passes key file errors through", async () => {
  const random = createSeededRandom(3);
  const keyring = newKeyring({ random });
  const text = await exportBackup({ keyring, passphrase: PASS, random });
  const workspaceText = await workspaceFileFor(keyring, { random });
  await assert.rejects(openKeyring({ text, passphrase: "not the right phrase", workspaceText }), (e) => e instanceof KeyFileError && e.code === "wrong-passphrase");
  await assert.rejects(openKeyring({ text: "{}", passphrase: PASS, workspaceText }), (e) => e instanceof KeyFileError && e.code === "bad-file");
  const invite = await mintInvite({ keyring, user: { id: "sam", name: "Sam" }, passphrase: PASS, random });
  await assert.rejects(openKeyring({ text: invite, passphrase: PASS, workspaceText }), (e) => e instanceof KeyFileError && e.code === "wrong-kind");
});

test("openKeyring rebuilds the keyring from a passport, without its user (plan 3.1 step 6)", async () => {
  const random = createSeededRandom(4);
  const keyring = newKeyring({ random });
  const invite = await mintInvite({ keyring, user: { id: "sam", name: "Sam" }, passphrase: PASS, random });
  const { passportText } = await enrol({ inviteText: invite, invitePassphrase: PASS, newPassphrase: "sam's own passport phrase", random });
  const opened = await openKeyring({ text: passportText, passphrase: "sam's own passport phrase", workspaceText: await workspaceFileFor(keyring, { random }) });
  assert.deepEqual(opened, { keyring, from: "passport" });
});

test("file names follow plan 3.3", () => {
  assert.equal(backupFileName({ current: 3 }), "workspace-key-3.keybackup.json");
  assert.equal(inviteFileName("sam"), "sam.invite.json");
});

test("writeWorkspace replaces the file in full", async () => {
  const folder = createMemFolder();
  await writeWorkspace(folder.root, "a much longer first version");
  await writeWorkspace(folder.root, "short");
  assert.deepEqual(await readWorkspace(folder.root), { status: "found", text: "short" });
});
