// The rubric runner (spec S6, Deliver 2): runs each gate's command, prints the
// table and exits non-zero on any fail. A gate whose check is missing fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gates } from "../build/rubric.js";

const RUBRIC = fileURLToPath(new URL("../build/rubric.js", import.meta.url));

function runFixture(list) {
  const dir = mkdtempSync(join(tmpdir(), "rubric-"));
  const file = join(dir, "gates.js");
  writeFileSync(file, `export const gates = ${list};\n`);
  return spawnSync(process.execPath, [RUBRIC, "--gates", file], { encoding: "utf8" });
}

const row = (out, id) => out.split("\n").find((line) => line.startsWith(`| ${id} `));

test("one passing and one failing gate: both rows printed, exit 1", () => {
  const run = runFixture(`[
    { id: "T1", requirement: "passes", command: "node -e \\"process.exit(0)\\"" },
    { id: "T2", requirement: "fails", command: "node -e \\"process.exit(3)\\"" },
  ]`);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(row(run.stdout, "T1"), /\| pass \|.*process\.exit\(0\)/);
  assert.match(row(run.stdout, "T2"), /\| fail \|.*process\.exit\(3\)/);
});

test("all gates passing: exit 0", () => {
  const run = runFixture(`[
    { id: "T1", requirement: "passes", command: "node -e \\"process.exit(0)\\"" },
    { id: "T2", requirement: "passes too", command: "node -e \\"process.exit(0)\\"" },
  ]`);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(row(run.stdout, "T1"), /\| pass \|/);
  assert.match(row(run.stdout, "T2"), /\| pass \|/);
});

test("a gate whose check is not present fails with that reason and its command is not run", () => {
  const run = runFixture(`[
    { id: "T1", requirement: "missing", command: "node -e \\"process.exit(0)\\"", present: () => false },
  ]`);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(row(run.stdout, "T1"), /\| fail: check not present \|/);
});

test("the real rubric lists G1 to G11 in order, each with a requirement and a command", () => {
  assert.deepEqual(gates.map((g) => g.id), ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11"]);
  for (const g of gates) {
    assert.ok(g.requirement, `${g.id} has no requirement`);
    assert.ok(g.command, `${g.id} has no command`);
  }
});

test("CI runs the one ci script, then the rubric as its own step", () => {
  const root = new URL("../../", import.meta.url);
  const scripts = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).scripts;
  assert.ok(scripts.ci, "root package.json has no ci script");
  // Every command line in the workflow, single-line `run:` or inside a `run: |` block.
  const lines = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8")
    .split("\n").map((l) => l.trim().replace(/^run: /, "")).filter((l) => l.startsWith("npm "));
  const ci = lines.indexOf("npm run ci");
  assert.ok(ci >= 0, `ci.yml does not run npm run ci: ${lines.join(" / ")}`);
  assert.ok(lines.indexOf("npm run rubric") > ci, "ci.yml does not run npm run rubric after npm run ci");
  assert.ok(!lines.some((l) => /^npm (test|ci|run (typecheck|build|test))\b/.test(l)), `ci.yml runs checks outside the ci script: ${lines.join(" / ")}`);
});
