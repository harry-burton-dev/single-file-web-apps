// The framework runs with no tables and names none of the app's (spec S1, gate G4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startHost } from "../host/host.ts";
import definition from "../../build/app-definition.js";
import { installFakeBrowser, hostConfig } from "./helpers/fake-browser.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

test("startHost with no tables starts and stops cleanly", async () => {
  const browser = installFakeBrowser();
  try {
    const started = await startHost(await hostConfig({ id: "empty", name: "Empty", tables: {} }));
    assert.equal(started.ok, true);
    await started.stop();
  } finally {
    browser.restore();
  }
});

test("no table or field name from app.config.ts is quoted in framework source", () => {
  const names = new Set();
  for (const [table, schema] of Object.entries(definition.tables)) {
    names.add(table);
    for (const field of Object.keys(schema.fields ?? {})) names.add(field);
  }
  assert.ok(names.size > 0, "the app declares at least one table");
  const files = execFileSync("git", ["ls-files", "framework"], { cwd: repo, encoding: "utf8" })
    .split("\n")
    // The engine's simulation harness drives synthetic tables of its own (notes,
    // title, owner...) and never ships in a bundle, so like tests it is not scanned.
    .filter((f) => f && !/(^|\/)test\//.test(f) && !f.startsWith("framework/engine/src/harness/"));
  const found = [];
  for (const file of files) {
    const text = readFileSync(repo + file, "utf8");
    for (const name of names) {
      if (new RegExp(`["'\`]${name}["'\`]`).test(text)) found.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(found, []);
});
