// The user docs are checked, not trusted (framework/build/docs-check.js):
// every public export has a reference entry, every link resolves, and every
// sample typechecks against the public entry and imports only what app code may.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { anchors, brokenLinks, checkSamples, docFiles, documentedNames, exportCoverage, exportedNames, samplesOf } from "../build/docs-check.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));

test("every export of the public entry has an entry in the API reference, and no entry names a non-export", () => {
  const { exported, undocumented, unknown, duplicated } = exportCoverage(repo);
  assert.ok(exported.length > 0, "the public entry exports something");
  assert.deepEqual(undocumented, [], "exports with no heading in docs/reference/api.md");
  assert.deepEqual(unknown, [], "headings in docs/reference/api.md that name no export");
  assert.deepEqual(duplicated, [], "exports documented twice");
});

test("every relative link and anchor in the user docs resolves", () => {
  assert.ok(docFiles(repo).includes("docs/quickstart.md"), "docs/quickstart.md exists");
  assert.deepEqual(brokenLinks(repo), []);
});

test("every sample typechecks against the public entry and imports only what app code may", { timeout: 600_000 }, async () => {
  const { compiled, failures } = await checkSamples(repo);
  assert.ok(compiled > 0, "the docs hold samples");
  assert.equal(failures.length, 0, `\n${failures.join("\n\n")}`);
});

// The checks themselves: each is seen to fail on a bad input.

test("exportedNames reads value and type exports, and renames", () => {
  const source = 'export { a, type B } from "./x";\nexport type { C,\n  D } from "./y";\nexport { e as f } from "./z";';
  assert.deepEqual(exportedNames(source), ["B", "C", "D", "a", "f"]);
});

test("documentedNames reads only headings that are one name in code, outside samples", () => {
  const page = "## Hooks\n### `useRecords`\n```ts\n### `notAHeading`\n```\n### Not `this` one\n#### `Row`\n";
  assert.deepEqual(documentedNames(page), ["Row", "useRecords"]);
});

test("anchors follow GitHub: lower case, punctuation dropped, repeats numbered", () => {
  assert.deepEqual(anchors("# Read with hooks\n## `useRecords(table, query?)`\n## Usage\n## Usage\n"), ["read-with-hooks", "userecordstable-query", "usage", "usage-1"]);
});

test("samplesOf names a sample by its first-line comment, numbers the rest, and skips signatures", () => {
  const page = ["```tsx", "// app/src/screen.tsx", "export {};", "```", "```ts", "export {};", "```", "```ts signature", "function f(): void", "```", "```json", "{}", "```"].join("\n");
  assert.deepEqual(
    samplesOf(page).map(({ path, skipped, line }) => ({ path, skipped, line })),
    [
      { path: "app/src/screen.tsx", skipped: false, line: 2 },
      { path: "app/src/sample-1.ts", skipped: false, line: 6 },
      { path: "app/src/sample-2.ts", skipped: true, line: 9 },
    ],
  );
});
