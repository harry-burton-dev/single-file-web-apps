// Gate G6: no fixed key in the build. The scan used by `npm run check:no-test-key`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTestKey } from "../build/no-test-key.js";

test("finds the old seed or helper name anywhere under the folder, and nothing in a clean one", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "no-test-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "bootstrap.html"), "<p>clean</p>");
  writeFileSync(join(dir, "app", "a.js"), "const ok = 1;");
  assert.deepEqual(findTestKey(dir), []);
  // Split so this file does not match the repository-wide checks itself.
  writeFileSync(join(dir, "app", "b.js"), `const s = "engine-${"test-page-key"}-v1";`);
  writeFileSync(join(dir, "c.js"), `export { ${"testWorkspace"}Key };`);
  assert.deepEqual(findTestKey(dir).sort(), ["app/b.js: test-page-key", "c.js: testWorkspaceKey"]);
});

test("the app source no longer holds the test key", () => {
  assert.deepEqual(findTestKey(new URL("../../app/src", import.meta.url).pathname), []);
});
