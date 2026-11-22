// Gate G2: no leftover names in a created project. Decided by Harry on
// 2026-11-21 (OUT-30): outside node_modules and the lockfile, "trellis" may
// appear only as the framework identifiers below and in the one attribution
// line. The old app name may appear nowhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ATTRIBUTION, createProject } from "../create.js";

const ALLOWED = ["@trellis/framework", "TRELLIS_PUBLIC_KEY", "TRELLIS_SIGNING_KEY", "TrellisApp"];
// Split so this file does not match the old-name check (framework/test/no-old-name.test.js).
const OLD_NAME = ["work", "bench"].join("");
const NAMES = new RegExp(`trellis|${OLD_NAME}`, "i");
const SKIP = new Set(["node_modules", ".git", "package-lock.json"]);

/** Every line in `root` that names trellis or the old name other than as allowed, plus the attribution count. */
function leftoverNames(root) {
  const found = [];
  let attributions = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const path = join(dir, entry);
      const rel = relative(root, path);
      if (NAMES.test(entry)) found.push(`${rel} (file name)`);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      readFileSync(path, "utf8").split("\n").forEach((line, i) => {
        if (line === ATTRIBUTION) { attributions += 1; return; }
        const rest = ALLOWED.reduce((s, word) => s.replaceAll(word, ""), line);
        if (NAMES.test(rest)) found.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
  };
  walk(root);
  return { found, attributions };
}

test("G2: a created project names trellis only in the allowed places, and the old name nowhere", () => {
  const target = createProject("demo-app", { dir: mkdtempSync(join(tmpdir(), "create-names-")), check: false });
  const { found, attributions } = leftoverNames(target);
  assert.deepEqual(found, []);
  assert.equal(attributions, 1, "exactly one attribution line");
});

test("the check fails when a leftover name is present", () => {
  const target = createProject("demo-app", { dir: mkdtempSync(join(tmpdir(), "create-names-")), check: false });
  appendFileSync(join(target, "app/app.config.ts"), `// trellis-example\n// a ${OLD_NAME.toUpperCase()} note\n`);
  appendFileSync(join(target, "README.md"), `${ATTRIBUTION}\n`);
  const { found, attributions } = leftoverNames(target);
  assert.equal(found.length, 2, found.join("\n"));
  assert.equal(attributions, 2);
});
