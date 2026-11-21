// Every name an app uses comes from its definition's id and name (spec S1, gate G3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { appNames } from "../names.ts";
import { assertAppDefinition } from "../definition.ts";
import definition from "../../build/app-definition.js";

test("appNames derives every name from the id and name", () => {
  for (const [def, expected] of [
    [{ id: "acme-notes", name: "Acme Notes" }, { id: "acme-notes", name: "Acme Notes" }],
    [{ id: "farm2", name: "Farm Ledger" }, { id: "farm2", name: "Farm Ledger" }],
  ]) {
    const names = appNames(def);
    const { id, name } = expected;
    assert.equal(names.database, id);
    assert.equal(names.deviceLock("d1"), `${id}-device-d1`);
    assert.equal(names.folderPicker, id);
    assert.equal(names.title, name);
    assert.equal(names.bootstrapFile, `${id}.html`);
    assert.equal(names.bundleFile("1.2.3"), `${id}-1.2.3.js`);
    assert.equal(names.releaseFolder, name);
    assert.equal(names.releaseZip("1.2.3"), `${id}-1.2.3.zip`);
  }
});

test("assertAppDefinition refuses bad ids and empty names", () => {
  const ok = (id, name = "App") => ({ id, name, tables: {} });
  for (const id of ["Acme", "acme notes", "-acme", "acme-", "acme--notes", "", "acme_notes"]) {
    assert.throws(() => assertAppDefinition(ok(id)), undefined, `id ${JSON.stringify(id)}`);
  }
  assert.throws(() => assertAppDefinition(ok("acme", "")));
  assert.throws(() => assertAppDefinition({ name: "App", tables: {} }));
  assert.doesNotThrow(() => assertAppDefinition(ok("acme-notes-2")));
});

test("the repository's own definition is valid", () => {
  assert.doesNotThrow(() => assertAppDefinition(definition));
});

test("startHost asks for a device lock named after the app's id", async () => {
  const { startHost } = await import("../host/host.ts");
  const { installFakeBrowser, hostConfig } = await import("./helpers/fake-browser.js");
  for (const id of ["acme-notes", "farm2"]) {
    const browser = installFakeBrowser();
    try {
      const started = await startHost(await hostConfig({ id, name: "Some App", tables: { notes: { version: 1 } } }));
      assert.equal(started.ok, true);
      await started.stop();
      assert.deepEqual(browser.lockNames, [`${id}-device-${started.deviceId}`]);
    } finally {
      browser.restore();
    }
  }
});

test("an app may not define a table named users, in any case: it is the framework's", () => {
  for (const table of ["users", "Users", "USERS"]) {
    assert.throws(() => assertAppDefinition({ id: "acme", name: "App", tables: { [table]: { version: 1 } } }), /framework/, table);
  }
  assert.doesNotThrow(() => assertAppDefinition({ id: "acme", name: "App", tables: { "users-2": { version: 1 }, members: { version: 1 } } }));
});

test("startHost syncs the framework's users table beside the app's tables", async () => {
  const { startHost } = await import("../host/host.ts");
  const { installFakeBrowser, hostConfig } = await import("./helpers/fake-browser.js");
  const browser = installFakeBrowser();
  try {
    const started = await startHost(await hostConfig({ id: "acme", name: "App", tables: { notes: { version: 1 } } }));
    assert.equal(started.ok, true);
    assert.ok(started.engine.table("users"));
    assert.ok(started.engine.table("notes"));
    await started.stop();
  } finally {
    browser.restore();
  }
});
