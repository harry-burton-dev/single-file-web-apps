// Gate G5: app code imports only from the framework's public entry (spec S2, acceptance 4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findViolations, appPackages } from "../build/boundary.js";

const appDir = fileURLToPath(new URL("../../app/", import.meta.url));

test("the real app is clean", () => {
  assert.deepEqual(findViolations(appDir, { allowedPackages: appPackages(appDir) }), []);
});

test("app/package.json lists neither yjs nor a framework-internal path", () => {
  for (const name of appPackages(appDir)) {
    assert.notEqual(name, "yjs");
    assert.ok(!name.startsWith("@trellis/framework/"), name);
  }
});

test("rejects each kind of bad import", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "boundary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src", "deep"), { recursive: true });

  const bad = {
    "subpath.ts": `import { x } from "@trellis/framework/engine";`,
    "escape.ts": `import "../../framework/engine/src/engine/engine.js";`,
    "absolute.ts": `export { y } from "/home/someone/engine.js";`,
    "vite-alias.ts": `const m = await import("/@fs/framework/index.ts");`,
    "yjs.js": `const Y = require("yjs");`,
    "unlisted.tsx": `import * as Y from "lib0/encoding";`,
  };
  const good = {
    "entry.ts": `import { startHost } from "@trellis/framework";`,
    "own.tsx": `import { a } from "./entry";\nimport b from "@/deep/b";\nimport "./style.css?inline";`,
    "deep/b.ts": `import React from "react";\nimport { c } from "react-dom/client";\nexport default 1;`,
  };
  for (const [name, body] of Object.entries({ ...bad, ...good })) writeFileSync(join(dir, "src", name), body + "\n");

  const found = findViolations(dir, { allowedPackages: ["@trellis/framework", "react", "react-dom"] });
  const byFile = Object.groupBy(found, (v) => v.file.replace(/\\/g, "/"));
  assert.deepEqual(Object.keys(byFile).sort(), Object.keys(bad).map((n) => `src/${n}`).sort());
  for (const list of Object.values(byFile)) {
    assert.equal(list.length, 1);
    assert.equal(list[0].line, 1);
    assert.ok(list[0].reason);
  }
});

test("reports the line of a bad import", () => {
  const dir = mkdtempSync(join(tmpdir(), "boundary-"));
  try {
    writeFileSync(join(dir, "a.ts"), `import { a } from "@trellis/framework";\n\nimport { b } from "yjs";\n`);
    const [v] = findViolations(dir, { allowedPackages: ["@trellis/framework"] });
    assert.deepEqual(v, { file: "a.ts", line: 3, specifier: "yjs", reason: "package not listed in app/package.json" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
