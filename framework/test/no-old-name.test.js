// The old app name is gone from tracked files outside docs/ (spec S1, acceptance).
// docs/ keeps the history under the old name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
// Split so this file does not match itself.
const OLD_NAME = ["work", "bench"].join("");

test("git grep finds the old name nowhere outside docs/", () => {
  const grep = spawnSync("git", ["grep", "-n", "-i", OLD_NAME, "--", ".", ":!docs"], { cwd: repo, encoding: "utf8" });
  // git grep exits 1 when nothing matches, 0 on a match, and higher on an error.
  assert.ok(grep.status === 0 || grep.status === 1, `git grep failed: ${grep.stderr}`);
  assert.deepEqual(grep.stdout.split("\n").filter(Boolean), []);
});
