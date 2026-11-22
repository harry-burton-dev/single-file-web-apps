// Tailwind sees the shell's classes (spec S4, Deliver 3): a class used only
// under framework/runtime/shell/ is in the built app bundle. Without the
// app stylesheet's @source for the shell folder it would be missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { appConfig } from "../../build/vite.config.js";
import definition from "../../build/app-definition.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
// From the diagnostics view's list of sync attempts.
const SHELL_ONLY_CLASS = "max-h-96";

function read(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? read(path) : [readFileSync(path, "utf8")];
  }).join("\n");
}

test(`the shell-only class ${SHELL_ONLY_CLASS} is in the built bundle`, async (t) => {
  assert.ok(read(join(repo, "framework/runtime/shell")).includes(SHELL_ONLY_CLASS), "the shell uses the class");
  assert.ok(!read(join(repo, "app/src")).includes(SHELL_ONLY_CLASS), "the app does not");
  const outDir = mkdtempSync(join(tmpdir(), "shell-styles-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  await build({ ...appConfig({ definition, version: "0.0.0", mode: "app", outDir }), configFile: false, logLevel: "error" });
  const bundle = read(join(outDir, "app"));
  assert.ok(bundle.includes(`.${SHELL_ONLY_CLASS}{`), `no .${SHELL_ONLY_CLASS} rule in the built bundle`);
});
