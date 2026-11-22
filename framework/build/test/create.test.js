// `npm run create -- <name>` (spec S6, Deliver 1; gate G1). These tests live
// outside `npm test` on purpose: a created project runs `npm test`, and the
// G1 test runs a created project's `npm run ci`, so inside `npm test` it would
// recurse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject } from "../create.js";

const CREATE = fileURLToPath(new URL("../create.js", import.meta.url));
const parent = () => mkdtempSync(join(tmpdir(), "create-"));
const json = (file) => JSON.parse(readFileSync(file, "utf8"));

test("an invalid name is refused and leaves nothing behind", () => {
  const dir = parent();
  for (const name of ["Demo App", "demo_app", "-demo", "demo--app", ""]) {
    assert.throws(() => createProject(name, { dir, check: false }), /name/i, name);
  }
  assert.deepEqual(readdirSync(dir), []);
});

test("an existing folder is refused and left as it was", () => {
  const dir = parent();
  mkdirSync(join(dir, "demo-app"));
  writeFileSync(join(dir, "demo-app", "mine.txt"), "keep");
  assert.throws(() => createProject("demo-app", { dir, check: false }), /exists/);
  assert.deepEqual(readdirSync(join(dir, "demo-app")), ["mine.txt"]);
});

test("the copy has its own names, version 0.1.0, and no framework docs or history", () => {
  const target = createProject("demo-app", { dir: parent(), check: false });
  const config = readFileSync(join(target, "app/app.config.ts"), "utf8");
  assert.match(config, /id: "demo-app",/);
  assert.match(config, /name: "Demo App",/);
  assert.equal(json(join(target, "package.json")).name, "demo-app");
  assert.equal(json(join(target, "package.json")).version, "0.1.0");
  assert.equal(json(join(target, "app/package.json")).name, "demo-app-app");
  assert.equal(json(join(target, "app/package.json")).version, "0.1.0");
  for (const gone of ["docs/framework", "docs/sync-engine-test-spec.md", "docs/adr-0001-sync-engine.md", "epics", "node_modules", "dist"]) {
    assert.ok(!existsSync(join(target, gone)), `${gone} should not be copied`);
  }
  const docs = existsSync(join(target, "docs")) ? readdirSync(join(target, "docs")) : [];
  assert.deepEqual(docs.filter((f) => f.startsWith("adr-")), []);
  // A fresh repository: `git init` ran, and none of this repository's commits came along.
  assert.ok(existsSync(join(target, ".git")));
  assert.notEqual(spawnSync("git", ["log", "-1"], { cwd: target }).status, 0, "the created project should have no commits");
});

test("G1: create demo-app ends with the created project's own `npm run ci` passing", { timeout: 20 * 60 * 1000 }, () => {
  const dir = parent();
  const run = spawnSync(process.execPath, [CREATE, "demo-app", "--dir", dir], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const out = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, out.split("\n").slice(-60).join("\n"));
  assert.match(out, /npm run ci passed/);
  assert.ok(existsSync(join(dir, "demo-app", "dist")), "the created project's build should have run");
});
