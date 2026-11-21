// The stand-in folder, driven from two browser contexts on a page opened from
// disk (file://), the way two-users.js uses it. Needs Playwright with Chromium.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createStandInFolder } from "../stand-in-folder.js";

const { chromium } = createRequire(import.meta.url)("playwright");

let browser, folder, pageDir, A, B;

async function open(label) {
  const context = await browser.newContext();
  await folder.attach(context, label);
  const page = await context.newPage();
  await page.goto(pathToFileURL(join(pageDir, "blank.html")).href);
  return page;
}

/** Runs `body` in the page with `root` bound to the picked folder; returns its result or the thrown error's name. */
const inPage = (page, body, arg) =>
  page.evaluate(
    async ([source, arg]) => {
      const root = await window.showDirectoryPicker();
      try {
        return await new Function("root", "arg", `return (async () => { ${source} })();`)(root, arg);
      } catch (err) {
        return `threw ${err.name}`;
      }
    },
    [body, arg],
  );

const writeIn = (page, parts, name, text) =>
  inPage(
    page,
    `let dir = root;
     for (const part of arg.parts) dir = await dir.getDirectoryHandle(part, { create: true });
     const w = await (await dir.getFileHandle(arg.name, { create: true })).createWritable();
     await w.write(new TextEncoder().encode(arg.text));
     await w.close();
     return "written";`,
    { parts, name, text },
  );

const readIn = (page, parts, name) =>
  inPage(
    page,
    `let dir = root;
     for (const part of arg.parts) dir = await dir.getDirectoryHandle(part);
     const file = await (await dir.getFileHandle(arg.name)).getFile();
     return new TextDecoder().decode(await file.arrayBuffer());`,
    { parts, name },
  );

const listIn = (page, parts) =>
  inPage(
    page,
    `let dir = root;
     for (const part of arg.parts) dir = await dir.getDirectoryHandle(part);
     const out = [];
     for await (const [name, handle] of dir.entries()) out.push(name + ":" + handle.kind);
     return out.sort();`,
    { parts },
  );

before(async () => {
  pageDir = mkdtempSync(join(tmpdir(), "stand-in-page-"));
  writeFileSync(join(pageDir, "blank.html"), "<!doctype html><title>blank</title>");
  folder = await createStandInFolder();
  mkdirSync(join(folder.dir, "app"));
  writeFileSync(join(folder.dir, "app", "seed.txt"), "seeded");
  browser = await chromium.launch();
  A = await open("A");
  B = await open("B");
});

after(async () => {
  await browser?.close();
  await folder?.close();
  rmSync(pageDir, { recursive: true, force: true });
});

test("the picker returns a folder with read-write permission granted", async () => {
  assert.deepEqual(await inPage(A, `return [root.kind, typeof root.name, await root.queryPermission({ mode: "readwrite" }), await root.requestPermission({ mode: "readwrite" })];`), ["directory", "string", "granted", "granted"]);
});

test("files placed in the folder from Node are readable in the page", async () => {
  assert.equal(await readIn(A, ["app"], "seed.txt"), "seeded");
});

test("a file written by one context is read by the other, and lands on disk", async () => {
  assert.equal(await writeIn(A, ["data", "t", "a"], "000001.ywb", "from A"), "written");
  assert.equal(await readIn(B, ["data", "t", "a"], "000001.ywb"), "from A");
  assert.equal(readFileSync(join(folder.dir, "data", "t", "a", "000001.ywb"), "utf8"), "from A");
  assert.deepEqual(await listIn(B, ["data", "t"]), ["a:directory"]);
  assert.deepEqual(await listIn(B, ["data", "t", "a"]), ["000001.ywb:file"]);
});

test("getFile reports the size and modification time on disk", async () => {
  const meta = await inPage(B, `const f = await (await (await (await (await root.getDirectoryHandle("data")).getDirectoryHandle("t")).getDirectoryHandle("a")).getFileHandle("000001.ywb")).getFile(); return [f.size, f.lastModified];`);
  const stat = statSync(join(folder.dir, "data", "t", "a", "000001.ywb"));
  assert.deepEqual(meta, [stat.size, Math.floor(stat.mtimeMs)]);
});

test("replacing a file always moves its modification time forward", async () => {
  const path = join(folder.dir, "data", "t", "a", "000001.ywb");
  const before = Math.floor(statSync(path).mtimeMs);
  await writeIn(A, ["data", "t", "a"], "000001.ywb", "from A");
  assert.ok(Math.floor(statSync(path).mtimeMs) > before);
});

test("a file read after it changed fails as a real File does", async () => {
  const result = await inPage(
    A,
    `const dir = await (await (await root.getDirectoryHandle("data")).getDirectoryHandle("t")).getDirectoryHandle("a");
     const stale = await (await dir.getFileHandle("000001.ywb")).getFile();
     const w = await (await dir.getFileHandle("000001.ywb")).createWritable();
     await w.write(new TextEncoder().encode("changed"));
     await w.close();
     await stale.arrayBuffer();`,
  );
  assert.equal(result, "threw NotReadableError");
});

test("getFileHandle with create makes an empty file", async () => {
  assert.equal(await inPage(A, `return (await (await root.getFileHandle("empty.txt", { create: true })).getFile()).size;`), 0);
  assert.equal(readFileSync(join(folder.dir, "empty.txt"), "utf8"), "");
});

test("missing entries throw NotFoundError, and removeEntry deletes", async () => {
  assert.equal(await inPage(A, `await root.getFileHandle("nope.txt");`), "threw NotFoundError");
  assert.equal(await inPage(A, `await root.getDirectoryHandle("nope");`), "threw NotFoundError");
  assert.equal(await inPage(A, `await root.removeEntry("nope.txt");`), "threw NotFoundError");
  assert.equal(await inPage(B, `await root.removeEntry("empty.txt"); return "removed";`), "removed");
  assert.equal(await inPage(A, `await root.getFileHandle("empty.txt");`), "threw NotFoundError");
});

test("a file and a directory are told apart", async () => {
  assert.equal(await inPage(A, `await root.getDirectoryHandle("app").then((d) => d.getDirectoryHandle("seed.txt"));`), "threw TypeMismatchError");
  assert.equal(await inPage(A, `await root.getFileHandle("app");`), "threw TypeMismatchError");
});

test("names with a path separator are refused", async () => {
  assert.equal(await inPage(A, `await root.getFileHandle("../escape.txt", { create: true });`), "threw TypeError");
});

test("while partitioned each context sees the folder as it was plus its own changes; healing merges both", async () => {
  await writeIn(A, [], "before.txt", "shared");
  await folder.partition(true);
  await writeIn(A, ["data", "t", "a"], "000002.ywb", "A offline");
  await writeIn(B, ["data", "t", "b"], "000001.ywb", "B offline");
  await inPage(B, `await root.removeEntry("before.txt");`);

  assert.equal(await readIn(A, [], "before.txt"), "shared");
  assert.equal(await readIn(B, [], "before.txt"), "threw NotFoundError");
  assert.equal(await readIn(B, ["data", "t", "a"], "000002.ywb"), "threw NotFoundError");
  assert.deepEqual(await listIn(A, ["data", "t"]), ["a:directory"]);
  assert.deepEqual(await listIn(B, ["data", "t"]), ["a:directory", "b:directory"]);
  assert.deepEqual(await listIn(A, ["data", "t", "a"]), ["000001.ywb:file", "000002.ywb:file"]);

  await folder.partition(false);
  assert.equal(await readIn(B, ["data", "t", "a"], "000002.ywb"), "A offline");
  assert.equal(await readIn(A, ["data", "t", "b"], "000001.ywb"), "B offline");
  assert.equal(await readIn(A, [], "before.txt"), "threw NotFoundError");
  assert.deepEqual(await listIn(A, ["data", "t"]), ["a:directory", "b:directory"]);
});
