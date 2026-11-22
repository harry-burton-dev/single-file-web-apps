// The admin page's restore step (OUT-48), without the page. Written before the code.
//
// "Restore into an empty folder" opens the key backup with its passphrase,
// restores the backup file into the folder (the device half is passed in, as
// the page passes the host's), and only then writes workspace.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../../../engine/src/engine/engine.js";
import { openTable } from "../../../engine/src/records/index.js";
import { createMemoryStore } from "../../../engine/src/store/memory.js";
import { yjsAdapter } from "../../../engine/src/adapters/yjs.js";
import { createMemFolder, createManualClock, createSeededRandom } from "../../../engine/test/helpers/memfolder.js";
import { KeyFileError } from "../../identity/keyfile.js";
import { checkKeyring, WORKSPACE_FILE } from "../../identity/workspace.js";
import { newKeyring, exportBackup, mintInvite, engineKeys, USERS_TABLE, USERS_SCHEMA, putUser } from "../../identity/admin.js";
import { writeBackup, packBackup, restoreBackup, BackupError } from "../../backup/backup.js";
import { restoreWorkspace, backupZipName, AdminError } from "../../admin/actions.js";

const PASS = "the admin's backup phrase";
const TABLES = { [USERS_TABLE]: "yjs" };
const ADAPTERS = { yjs: yjsAdapter };

/** A workspace with one users record, backed up and packed. */
async function backedUp() {
  const clock = createManualClock();
  const random = createSeededRandom(48);
  const keyring = newKeyring({ random });
  const keys = await engineKeys(keyring);
  const source = createMemFolder({ clock });
  const engine = await createEngine({ root: source.root, clock, random, store: createMemoryStore(), deviceId: "admin-aaaaaaaa", user: "admin", adapters: ADAPTERS, tables: TABLES, ...keys });
  const users = openTable({ doc: engine.table(USERS_TABLE), schema: USERS_SCHEMA, deviceId: "admin-aaaaaaaa", user: "admin", clock });
  putUser(users, { id: "harry", name: "Harry", role: "admin", status: "active" });
  const { stamp } = await writeBackup({ root: source.root, engine, tables: TABLES, adapters: ADAPTERS, key: keys.key, keyId: keys.keyId, clock, random });
  const file = await packBackup({ root: source.root, stamp });
  const json = JSON.stringify(yjsAdapter.toJSON(engine.table(USERS_TABLE)));
  await engine.close();
  return { clock, random, keyring, stamp, file, json, text: await exportBackup({ keyring, passphrase: PASS, random }) };
}

/** The device half, as the page's host does it: this device's engine config with the opened keyring. */
const deviceRestore = (b, store) => async (keyring, root, file) =>
  restoreBackup({ root, file, engineConfig: { clock: b.clock, random: b.random, store, deviceId: "admin-rrrrrrrr", user: "admin", adapters: ADAPTERS, tables: TABLES, ...(await engineKeys(keyring)) } });

test("backupZipName names the downloaded file after the backup's stamp", () => {
  assert.equal(backupZipName("20261122T030000Z"), "backup-20261122T030000Z.zip");
});

test("restoreWorkspace restores the tables, then writes a workspace.json that matches the key backup", async () => {
  const b = await backedUp();
  const target = createMemFolder({ clock: b.clock });
  const store = createMemoryStore();
  const result = await restoreWorkspace({ root: target.root, text: b.text, passphrase: PASS, file: b.file, restore: deviceRestore(b, store), random: b.random });
  assert.deepEqual(result.keyring, b.keyring);
  assert.deepEqual(result.tables, [USERS_TABLE]);
  assert.equal(await checkKeyring(b.keyring, new TextDecoder().decode(target.read(WORKSPACE_FILE))), "ok");
  const paths = target.writes.map((w) => w.path);
  assert.ok(paths.some((p) => p.startsWith("data/")), paths.join(", "));
  assert.equal(paths.at(-1), WORKSPACE_FILE, "workspace.json is written last, once the data is in the folder");

  const reopened = await createEngine({ root: target.root, clock: b.clock, random: b.random, store, deviceId: "admin-rrrrrrrr", user: "admin", adapters: ADAPTERS, tables: TABLES, ...(await engineKeys(b.keyring)) });
  assert.equal(JSON.stringify(yjsAdapter.toJSON(reopened.table(USERS_TABLE))), b.json);
  await reopened.close();
});

test("restoreWorkspace refuses a folder that has data/ in words, and writes no workspace.json", async () => {
  const b = await backedUp();
  const target = createMemFolder({ clock: b.clock });
  await (await target.root.getDirectoryHandle("data", { create: true })).getFileHandle("x", { create: true });
  await assert.rejects(
    restoreWorkspace({ root: target.root, text: b.text, passphrase: PASS, file: b.file, restore: deviceRestore(b, createMemoryStore()), random: b.random }),
    (err) => err instanceof BackupError && err.message === "This folder already has a data/ folder. Restore only into an empty folder.",
  );
  assert.equal(target.read(WORKSPACE_FILE), undefined);
});

test("restoreWorkspace refuses a folder that already has a workspace", async () => {
  const b = await backedUp();
  const target = createMemFolder({ clock: b.clock });
  await (await target.root.getFileHandle(WORKSPACE_FILE, { create: true })).createWritable().then(async (w) => { await w.write(new TextEncoder().encode("{}")); await w.close(); });
  await assert.rejects(
    restoreWorkspace({ root: target.root, text: b.text, passphrase: PASS, file: b.file, restore: deviceRestore(b, createMemoryStore()), random: b.random }),
    (err) => err instanceof AdminError && err.code === "has-workspace" && err.message === "This folder already has a workspace. Restore only into an empty folder.",
  );
});

test("restoreWorkspace refuses a wrong passphrase or a file that is not a key backup, and writes nothing", async () => {
  const b = await backedUp();
  const target = createMemFolder({ clock: b.clock });
  const run = (text, passphrase) => restoreWorkspace({ root: target.root, text, passphrase, file: b.file, restore: deviceRestore(b, createMemoryStore()), random: b.random });
  await assert.rejects(run(b.text, "not the right phrase"), (e) => e instanceof KeyFileError && e.code === "wrong-passphrase");
  const invite = await mintInvite({ keyring: b.keyring, user: { id: "sam", name: "Sam" }, passphrase: PASS, random: b.random });
  await assert.rejects(run(invite, PASS), (e) => e instanceof KeyFileError && e.code === "wrong-kind");
  assert.deepEqual(target.writes, []);
});

test("restoreWorkspace with another workspace's key backup is refused by the backup, and writes nothing", async () => {
  const b = await backedUp();
  const target = createMemFolder({ clock: b.clock });
  const other = await exportBackup({ keyring: newKeyring({ random: createSeededRandom(99) }), passphrase: PASS, random: b.random });
  await assert.rejects(
    restoreWorkspace({ root: target.root, text: other, passphrase: PASS, file: b.file, restore: deviceRestore(b, createMemoryStore()), random: b.random }),
    (err) => err instanceof BackupError && err.code === "wrong-key",
  );
  assert.deepEqual(target.writes, []);
});
