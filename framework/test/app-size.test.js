// The example app stays small (spec S4, acceptance 4): every .ts and .tsx file
// under app/src plus app/app.config.ts, non-blank lines, under 150. If it cannot
// fit, the framework is missing something; the limit is not raised.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../../app/", import.meta.url));
const LIMIT = 150;

test(`the example app is under ${LIMIT} non-blank lines`, () => {
  const files = readdirSync(join(app, "src"), { recursive: true })
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => join("src", f))
    .concat("app.config.ts");
  const counts = Object.fromEntries(files.map((f) => [f, readFileSync(join(app, f), "utf8").split("\n").filter((l) => l.trim()).length]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`example app: ${total} of ${LIMIT} lines`, counts);
  assert.ok(total < LIMIT, `${total} lines: ${JSON.stringify(counts)}`);
});

test("the example app declares the items table and its screen", () => {
  const config = readFileSync(join(app, "app.config.ts"), "utf8");
  assert.match(config, /items:/);
  assert.match(readFileSync(join(app, "src", "main.tsx"), "utf8"), /<ItemsScreen \/>/);
});
