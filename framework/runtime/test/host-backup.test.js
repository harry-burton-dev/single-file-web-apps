// The host's half of backup and restore (OUT-48). Written before the code.
// engineTables gives the page the engine's tables and adapters, which
// writeBackup needs; restoreHost restores into a folder as this browser's device, with the
// same store, device id and lock as startHost, so the next startHost there
// carries on from the restored data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startHost, restoreHost, engineTables } from "../host/host.ts";
import { yjsAdapter } from "../../engine/src/adapters/yjs.js";
import { openTable } from "../../engine/src/records/index.js";
import { createMemFolder } from "../../engine/test/helpers/memfolder.js";
import { USERS_TABLE, USERS_SCHEMA, putUser } from "../identity/admin.js";
import { writeBackup, packBackup } from "../backup/backup.js";
import { installFakeBrowser, hostConfig, memoryDb } from "./helpers/fake-browser.js";

const APP = { id: "notes", name: "Notes", tables: { notes: { version: 1, fields: { title: "latest" } } } };
const json = (engine, table) => JSON.stringify(yjsAdapter.toJSON(engine.table(table)));

test("back up through startHost, restoreHost into an empty folder, and startHost there has the same tables", async () => {
  const browser = installFakeBrowser();
  try {
    const config = await hostConfig(APP);
    const source = await startHost(config);
    assert.equal(source.ok, true);
    const { tables, adapters } = engineTables(APP);
    assert.deepEqual(tables, { notes: "yjs", [USERS_TABLE]: "yjs" });
    const users = openTable({ doc: source.engine.table(USERS_TABLE), schema: USERS_SCHEMA, deviceId: source.deviceId, user: config.user, clock: source.clock });
    putUser(users, { id: "harry", name: "Harry", role: "admin", status: "active" });
    const { stamp } = await writeBackup({ root: config.root, engine: source.engine, tables, adapters, key: config.key, keyId: config.keyId, clock: source.clock, random: source.random });
    const file = await packBackup({ root: config.root, stamp });
    const before = { notes: json(source.engine, "notes"), users: json(source.engine, USERS_TABLE) };
    await source.stop();

    const target = { ...config, root: createMemFolder().root, db: memoryDb() };
    const restored = await restoreHost(target, file);
    assert.deepEqual(restored, { ok: true, tables: ["notes", USERS_TABLE] });
    const after = await startHost(target);
    assert.equal(after.ok, true);
    assert.deepEqual({ notes: json(after.engine, "notes"), users: json(after.engine, USERS_TABLE) }, before);
    await after.stop();
  } finally {
    browser.restore();
  }
});
