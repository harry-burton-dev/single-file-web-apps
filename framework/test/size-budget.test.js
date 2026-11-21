// Gate G11: the build fails when the bootstrap or the app bundle is over budget (spec S4, acceptance).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGETS, checkBudgets } from "../build/size-budget.js";
import { appNames } from "../runtime/names.ts";
import definition from "../build/app-definition.js";

const SCRIPT = fileURLToPath(new URL("../build/size-budget.js", import.meta.url));
const version = JSON.parse(readFileSync(new URL("../../app/package.json", import.meta.url), "utf8")).version;

/** A dist folder holding a small bootstrap page and app bundle, named as the build names them. */
function smallDist() {
  const dist = mkdtempSync(join(tmpdir(), "size-budget-"));
  mkdirSync(join(dist, "app"));
  writeFileSync(join(dist, "bootstrap.html"), "x".repeat(1_000));
  writeFileSync(join(dist, "app", appNames(definition).bundleFile(version)), "y".repeat(2_000));
  return dist;
}

const run = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: "pipe" }) };
  } catch (error) {
    return { code: error.status, out: `${error.stdout}${error.stderr}` };
  }
};

test("the budgets are the spec's: bootstrap under 50,000 bytes, bundle under 500,000", () => {
  assert.deepEqual(BUDGETS, { bootstrap: 50_000, bundle: 500_000 });
});

test("checkBudgets reports size and headroom, and flags only what is over", () => {
  const dist = smallDist();
  try {
    const results = checkBudgets({ dist, version, limits: { bootstrap: 1_500, bundle: 1_500 } });
    assert.deepEqual(
      results.map(({ name, bytes, limit, headroom, over }) => ({ name, bytes, limit, headroom, over })),
      [
        { name: "bootstrap", bytes: 1_000, limit: 1_500, headroom: 500, over: false },
        { name: "bundle", bytes: 2_000, limit: 1_500, headroom: -500, over: true },
      ],
    );
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("the check passes on small files and prints both sizes and the headroom", () => {
  const dist = smallDist();
  try {
    const { code, out } = run(["--dist", dist]);
    assert.equal(code, 0, out);
    assert.match(out, /bootstrap\s+1,000 bytes .*49,000 bytes headroom/);
    assert.match(out, /bundle\s+2,000 bytes .*498,000 bytes headroom/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("the check exits 1 when given a limit the file exceeds", () => {
  const dist = smallDist();
  try {
    const { code, out } = run(["--dist", dist, "--bundle-limit", "1999"]);
    assert.equal(code, 1, out);
    assert.match(out, /bundle\s+2,000 bytes .*OVER BUDGET by 1 byte/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("a file exactly at its limit is over: the budget is 'under'", () => {
  const dist = smallDist();
  try {
    assert.equal(run(["--dist", dist, "--bootstrap-limit", "1000"]).code, 1);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("a missing build output fails the check rather than passing it", () => {
  const dist = mkdtempSync(join(tmpdir(), "size-budget-"));
  try {
    const { code, out } = run(["--dist", dist]);
    assert.equal(code, 1, out);
    assert.match(out, /bootstrap\.html/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
