// Gate G6: the build holds no fixed key. Fails if any file under the build
// output (default dist/) contains the old test key's seed or helper name.
// Run after a build: `npm run check:no-test-key [folder]`.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN = ["test-page-key", "testWorkspaceKey"];

/** "<path>: <word>" for every forbidden word found in a file under dir. */
export function findTestKey(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const text = readFileSync(path, "latin1");
    for (const word of FORBIDDEN) if (text.includes(word)) found.push(`${relative(dir, path)}: ${word}`);
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? fileURLToPath(new URL("../../dist", import.meta.url));
  const found = findTestKey(dir);
  for (const line of found) console.error(`fixed test key in the build: ${line}`);
  if (found.length > 0) process.exit(1);
  console.log(`no fixed test key under ${dir}`);
}
