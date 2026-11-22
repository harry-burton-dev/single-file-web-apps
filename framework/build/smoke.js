// From-disk smoke test (ADR-0005 section 8, step 3). Builds the bootstrap and
// the app bundle with a throwaway signing key, lays out a release folder, and
// opens the bootstrap page from disk (file://) in headless Chrome:
//
//   1. first run: connect the folder, the signed bundle is verified and the app starts
//   2. reload: the app starts from the browser's cache, no folder needed
//   3. a manifest signed with another key is refused and nothing runs
//   4. enrol from an invite made here, reload, unlock with the passphrase; a
//      wrong passphrase, another workspace and an out-of-date passport each
//      show their message; IndexedDB holds no key, wrapped or not (OUT-11)
//   5. the admin page (OUT-10), also from disk: creates a workspace in a
//      stand-in folder, and reopens it from the downloaded key backup
//   6. backups (OUT-48): back up, download the backup, refuse to restore into
//      a folder with data/, restore into a second, empty stand-in folder and
//      compare the users table there with the original
//
// Headless Chrome cannot drive the real folder picker, so the picker is
// replaced by one that returns an in-page stand-in holding the release files.
// Reading a real folder handle is therefore NOT covered here; hashing,
// signature checks, the IndexedDB cache and running the bundle are real.
// Needs Playwright with Chromium installed. Exit code 1 on any failed check.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Hex, signManifest } from "../runtime/loader/manifest.js";
import { sealKeyFile } from "../runtime/identity/keyfile.js";
import { workspaceFileFor, checkKeyring } from "../runtime/identity/workspace.js";
import { newKeyring, rotateKeyring, openBackup } from "../runtime/identity/admin.js";
import { enrol } from "../runtime/identity/passport.js";
import { appNames } from "../runtime/names.ts";
import definition from "./app-definition.js";

const { chromium } = createRequire(import.meta.url)("playwright");
const { subtle } = webcrypto;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VITE_CONFIG = join(ROOT, "framework", "build", "vite.config.js");
const DIST = join(ROOT, "dist");
const RELEASE = join(DIST, "smoke-release");
const version = JSON.parse(readFileSync(join(ROOT, "app", "package.json"), "utf8")).version;
const names = appNames(definition);
const bundleName = names.bundleFile(version);
/** The app's shell (OUT-36) is on the page: the bundle ran. */
const shellShown = (page) => page.locator("#trellis-shell").count().then((n) => n === 1);

const newKey = () => subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

async function buildRelease() {
  const admin = await newKey();
  const publicJwk = JSON.stringify(await subtle.exportKey("jwk", admin.publicKey));
  const vite = (mode) => execFileSync("npx", ["vite", "build", "--config", VITE_CONFIG, "--mode", mode], { cwd: ROOT, stdio: "inherit", env: { ...process.env, TRELLIS_PUBLIC_KEY: publicJwk } });
  vite("bootstrap");
  vite("app");
  vite("admin");
  rmSync(RELEASE, { recursive: true, force: true });
  mkdirSync(join(RELEASE, "app"), { recursive: true });
  copyFileSync(join(DIST, "admin.html"), join(RELEASE, names.adminFile));
  copyFileSync(join(DIST, "bootstrap.html"), join(RELEASE, names.bootstrapFile));
  copyFileSync(join(DIST, "app", bundleName), join(RELEASE, "app", bundleName));
  const bundle = readFileSync(join(RELEASE, "app", bundleName));
  const body = { format: 1, serial: 1, channels: { stable: version }, bundles: { [version]: { file: bundleName, sha256: await sha256Hex(bundle, subtle), minBootstrap: 1 } } };
  const manifest = await signManifest({ body, privateKey: admin.privateKey, subtle });
  writeFileSync(join(RELEASE, "app", "manifest.json"), manifest);
  const forged = await signManifest({ body, privateKey: (await newKey()).privateKey, subtle });
  return { bundle, manifest, forged };
}

/**
 * Runs in the page before its own scripts: the folder picker returns an
 * in-page folder holding these files (read-only: app/<name>). Such an object
 * cannot be kept in IndexedDB as a real handle can, so the page's attempt to
 * remember it stores nothing instead.
 */
function fakePicker({ files }) {
  const missing = () => { throw new DOMException("not found", "NotFoundError"); };
  const fileHandle = (base64) => ({
    kind: "file",
    getFile: async () => new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))]),
  });
  const app = { kind: "directory", name: "app", getFileHandle: async (name) => (name in files ? fileHandle(files[name]) : missing()) };
  const root = { kind: "directory", name: "smoke-folder", fake: true, getDirectoryHandle: async (name) => (name === "app" ? app : missing()) };
  window.showDirectoryPicker = async () => root;
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    return put.call(this, value?.fake ? undefined : value, key);
  };
}

async function openPage(browser, files) {
  const context = await browser.newContext();
  const encoded = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, Buffer.from(bytes).toString("base64")]));
  await context.addInitScript(fakePicker, { files: encoded });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(pathToFileURL(join(RELEASE, names.bootstrapFile)).href);
  return { context, page, errors };
}

/**
 * The stand-in disk for step 4, kept here in Node so it survives page reloads.
 * (Kept in the page's sessionStorage, it was sometimes empty after a reload
 * of a page opened from disk.) "folder/" is the shared folder the folder
 * picker returns; "local/" is where the save picker puts the passport.
 * Files are base64 with a modification counter; directories are a set.
 */
function nodeDisk(seed) {
  const files = new Map();
  const dirs = new Set();
  let tick = 0;
  const put = (path, b64) => {
    files.set(path, { b64, mtime: ++tick });
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  };
  for (const [path, b64] of Object.entries(seed)) put(path, b64);
  const ops = {
    read: (path) => files.get(path) ?? null,
    put,
    isDir: (path) => dirs.has(path),
    mkdir: (path) => void dirs.add(path),
    children: (path) => [...[...dirs].map((p) => ({ dir: true, p })), ...[...files.keys()].map((p) => ({ dir: false, p }))].filter(({ p }) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/")),
    remove: (path) => void (files.delete(path) || dirs.delete(path)),
  };
  return { ...ops, call: (_source, op, ...args) => ops[op](...args) };
}

/**
 * Runs in the page before its own scripts, for step 4: file handles over the
 * Node-side disk (smokeDiskIo, exposed by the test). Such handles cannot be
 * kept in IndexedDB as real ones can, so a stored handle is replaced by a
 * marker and brought back when read.
 */
function fakeDisk() {
  const io = (...args) => window.smokeDiskIo(...args);
  const toB64 = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const notFound = () => { throw new DOMException("not found", "NotFoundError"); };
  const granted = { queryPermission: async () => "granted", requestPermission: async () => "granted" };
  const bytesOf = (data) => (typeof data === "string" ? new TextEncoder().encode(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data));
  const file = (path) => ({
    ...granted, kind: "file", name: path.split("/").pop(), fake: path,
    getFile: async () => { const v = (await io("read", path)) ?? notFound(); return new File([fromB64(v.b64)], path.split("/").pop(), { lastModified: v.mtime }); },
    createWritable: async () => {
      const parts = [];
      return { write: async (data) => void parts.push(...bytesOf(data)), close: () => io("put", path, toB64(parts)), abort: async () => undefined };
    },
  });
  const dir = (path) => ({
    ...granted, kind: "directory", name: path === "folder" ? "smoke-folder" : path.split("/").pop(), fake: `dir:${path}`,
    getDirectoryHandle: async (name, { create = false } = {}) => {
      const p = `${path}/${name}`;
      if (!(await io("isDir", p))) { if (!create) notFound(); await io("mkdir", p); }
      return dir(p);
    },
    getFileHandle: async (name, { create = false } = {}) => {
      const p = `${path}/${name}`;
      if (!(await io("read", p))) { if (!create) notFound(); await io("put", p, ""); }
      return file(p);
    },
    async *entries() { for (const c of await io("children", path)) yield [c.p.split("/").pop(), c.dir ? dir(c.p) : file(c.p)]; },
    removeEntry: (name) => io("remove", `${path}/${name}`),
  });
  window.showDirectoryPicker = async () => dir("folder");
  window.showSaveFilePicker = async ({ suggestedName }) => file(`local/${suggestedName}`);
  const revive = (marker) => (marker.startsWith("dir:") ? dir(marker.slice(4)) : file(marker));
  const putReal = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    return putReal.call(this, value?.fake ? { smokeFake: value.fake } : value, key);
  };
  const getReal = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (key) {
    const real = getReal.call(this, key);
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    real.onsuccess = () => { request.result = real.result?.smokeFake ? revive(real.result.smokeFake) : real.result; request.onsuccess?.(); };
    real.onerror = () => { request.error = real.error; request.onerror?.(); };
    return request;
  };
}

/** Runs in the page: every value in every IndexedDB database, scanned for keys. */
async function scanIndexedDb() {
  const found = { cryptoKeys: 0, keyFiles: 0, passportHandle: null };
  const scan = (value, seen = new Set()) => {
    if (value instanceof CryptoKey) found.cryptoKeys += 1;
    else if (typeof value === "string" && value.includes('"kdf"')) found.keyFiles += 1;
    else if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer) && !seen.has(value)) {
      seen.add(value);
      for (const v of value instanceof Map ? value.values() : Object.values(value)) scan(v, seen);
    }
  };
  const done = (request) => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  for (const { name } of await indexedDB.databases()) {
    const db = await done(indexedDB.open(name));
    for (const store of db.objectStoreNames) {
      const tx = db.transaction(store);
      const [keys, values] = await Promise.all([done(tx.objectStore(store).getAllKeys()), done(tx.objectStore(store).getAll())]);
      keys.forEach((key, i) => { if (key === "host/passport-handle") found.passportHandle = values[i]?.smokeFake ?? null; });
      values.forEach((v) => scan(v));
    }
    db.close();
  }
  return found;
}

/**
 * Runs in the admin page before its own scripts: the folder picker returns the
 * browser's private file area if a page from disk may use it, else an in-page
 * folder that can be written (holding `files`, path to base64). As in
 * fakePicker, the in-page folder is not kept in IndexedDB.
 */
function standInFolder({ files }) {
  const notFound = () => new DOMException("not found", "NotFoundError");
  const mismatch = () => new DOMException("wrong kind", "TypeMismatchError");
  let tick = Date.now();
  const file = (name) => {
    const f = {
      kind: "file", name, bytes: new Uint8Array(0), modified: tick,
      getFile: async () => new File([f.bytes], name, { lastModified: f.modified }),
      async createWritable() {
        const parts = [];
        return {
          write: async (data) => void parts.push(data),
          async close() {
            f.bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
            f.modified = tick = Math.max(Date.now(), tick + 1);
          },
          abort: async () => undefined,
        };
      },
    };
    return f;
  };
  const dir = (name) => {
    const children = new Map();
    const get = (child, create, make, kind) => {
      if (!children.has(child)) {
        if (!create) throw notFound();
        children.set(child, make(child));
      }
      const found = children.get(child);
      if (found.kind !== kind) throw mismatch();
      return found;
    };
    return {
      kind: "directory", name, fake: true,
      getDirectoryHandle: async (child, { create = false } = {}) => get(child, create, dir, "directory"),
      getFileHandle: async (child, { create = false } = {}) => get(child, create, file, "file"),
      removeEntry: async (child) => void (children.delete(child) || (() => { throw notFound(); })()),
      async *entries() { yield* [...children]; },
      async *values() { yield* [...children.values()]; },
      async *keys() { yield* [...children.keys()]; },
      queryPermission: async () => "granted",
      requestPermission: async () => "granted",
    };
  };
  const inPage = dir("smoke-admin-folder");
  const seeded = (async () => {
    for (const [path, base64] of Object.entries(files)) {
      const parts = path.split("/");
      let d = inPage;
      for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
      const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await w.write(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
      await w.close();
    }
  })();
  window.showDirectoryPicker = async () => {
    await seeded;
    try {
      const area = await navigator.storage.getDirectory();
      if (Object.keys(files).length === 0) return (window.__standIn = { kind: "private file area", root: area }).root;
    } catch {
      // Chrome refuses the private file area to pages opened from disk
    }
    return (window.__standIn = { kind: "in-page folder", root: inPage }).root;
  };
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    return put.call(this, value?.fake ? undefined : value, key);
  };
}

/** Every file in the stand-in folder, path to text. */
const standInFiles = (page) =>
  page.evaluate(async () => {
    const out = {};
    const walk = async (dir, prefix) => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "directory") await walk(handle, `${prefix}${name}/`);
        else out[prefix + name] = await (await handle.getFile()).text();
      }
    };
    await walk(window.__standIn.root, "");
    return { kind: window.__standIn.kind, files: out };
  });

async function openAdmin(browser, files = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  const encoded = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, Buffer.from(text).toString("base64")]));
  await context.addInitScript(standInFolder, { files: encoded });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(pathToFileURL(join(RELEASE, names.adminFile)).href);
  await page.click("#admin-folder");
  return { context, page, errors };
}

/** Clicks and returns the downloaded file's name, text and bytes. */
async function downloadFrom(page, selector) {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), page.click(selector)]);
  const bytes = readFileSync(await download.path());
  return { name: download.suggestedFilename(), text: bytes.toString("utf8"), bytes };
}

const ADMIN_PASS = "the smoke test's backup phrase";
const INVITE_PASS = "a one-time invite phrase";
const message = (page) => page.locator("#admin-message").textContent().catch(() => "");

async function adminSmoke(browser) {
  const create = await openAdmin(browser);
  const { page } = create;
  await page.waitForSelector("#admin-create", { timeout: 10000 });
  await page.fill("#admin-name", "Harry");
  await page.fill("#admin-pass", "too short");
  await page.fill("#admin-pass-again", "too short");
  await page.click("#admin-create");
  await page.waitForFunction(() => document.getElementById("admin-message")?.textContent !== "", null, { timeout: 10000 }).catch(() => {});
  check("admin: a passphrase under 12 characters is refused", (await message(page)) === "Use a passphrase of at least 12 characters.", await message(page));

  await page.fill("#admin-pass", ADMIN_PASS);
  await page.fill("#admin-pass-again", ADMIN_PASS);
  await page.click("#admin-create");
  await page.waitForSelector("#admin-backup", { timeout: 20000 });
  check("admin: Finish waits until the key backup is downloaded", await page.locator("#admin-finish").isDisabled());
  const backup = await downloadFrom(page, "#admin-backup");
  const keyring = await openBackup({ text: backup.text, passphrase: ADMIN_PASS }).catch(() => null);
  check("admin: the key backup downloads and opens with its passphrase", backup.name === "workspace-key-1.keybackup.json" && keyring?.current === 1, backup.name);

  await page.click("#admin-finish");
  await page.waitForSelector("#admin-workspace", { timeout: 10000 }).catch(() => {});
  const row = await page.locator('tr[data-user="harry"]').innerText().catch(() => "");
  check("admin: the workspace opens with the admin's users record", /Harry\s+harry\s+admin\s+active/.test(row), `${row} / ${await message(page)}`);

  await page.fill("#admin-user-name", "Sam");
  await page.fill("#admin-invite-pass", INVITE_PASS);
  const invite = await downloadFrom(page, "#admin-invite");
  const enrolled = await enrol({ inviteText: invite.text, invitePassphrase: INVITE_PASS, newPassphrase: "sam's own passport phrase", random: { bytes: (n) => webcrypto.getRandomValues(new Uint8Array(n)) } }).catch((e) => e);
  check("admin: an invite downloads and a user can enrol from it", invite.name === "sam.invite.json" && enrolled.user?.id === "sam", `${invite.name} ${enrolled.message ?? ""}`);

  await page.waitForFunction(() => document.querySelector('tr[data-user="sam"]'), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500); // a tick or two, so the engine has saved and written its status file
  const folder = await standInFiles(page);
  const paths = Object.keys(folder.files);
  check(`admin: workspace.json is written and matches the backup (${folder.kind})`, keyring && (await checkKeyring(keyring, folder.files["workspace.json"] ?? "")) === "ok", paths.join(", "));
  check("admin: the users table's files are written", paths.some((p) => p.startsWith("data/") && p.includes("users")) && paths.some((p) => p.startsWith("status/")), paths.join(", "));

  await page.click("#admin-backup-now");
  await page.waitForFunction(() => document.getElementById("admin-message")?.textContent?.startsWith("Backup "), null, { timeout: 10000 }).catch(() => {});
  const backedUp = Object.keys((await standInFiles(page)).files).filter((p) => p.startsWith("backups/"));
  check("admin: Back up now writes one file per table under backups/<stamp>/", backedUp.some((p) => /^backups\/\d{8}T\d{6}Z\/users\.ywb$/.test(p)), `${backedUp.join(", ")} / ${await message(page)}`);
  const zip = await downloadFrom(page, "#admin-download-zip");
  check("admin: Download backup gives one zip file", /^backup-\d{8}T\d{6}Z\.zip$/.test(zip.name) && zip.bytes.subarray(0, 4).equals(Buffer.from("PK\x03\x04", "latin1")), zip.name);
  const usersShown = await page.locator("tbody").first().innerText();
  check("admin: no page errors while creating", create.errors.length === 0, create.errors.join(" | "));
  await create.context.close();

  await restoreSmoke(browser, { backup, zip, keyring, usersShown });

  // A later session: the folder has a workspace, the admin opens it from the backup.
  const reopen = await openAdmin(browser, { "workspace.json": folder.files["workspace.json"] });
  await reopen.page.waitForSelector("#admin-open", { timeout: 10000 });
  await reopen.page.setInputFiles("#admin-file", { name: backup.name, mimeType: "application/json", buffer: Buffer.from(backup.text) });
  await reopen.page.fill("#admin-open-pass", "not the right passphrase");
  await reopen.page.click("#admin-open");
  await reopen.page.waitForFunction(() => document.getElementById("admin-message")?.textContent !== "", null, { timeout: 10000 }).catch(() => {});
  check("admin: a wrong passphrase is refused with the key file's message", (await message(reopen.page)) === "That passphrase does not open this file.", await message(reopen.page));
  await reopen.page.fill("#admin-open-pass", ADMIN_PASS);
  await reopen.page.click("#admin-open");
  await reopen.page.waitForSelector("#admin-workspace", { timeout: 10000 }).catch(() => {});
  const shown = await reopen.page.locator("#admin-workspace").textContent().catch(() => "");
  check("admin: an existing workspace opens from its key backup", shown.includes(keyring?.workspace ?? "?"), `${shown} / ${await message(reopen.page)}`);
  check("admin: no page errors while reopening", reopen.errors.length === 0, reopen.errors.join(" | "));
  await reopen.context.close();
}

/** Fills in the restore form on an empty folder's first screen and clicks Restore. */
async function restoreInto(page, { backup, zip }) {
  await page.waitForSelector("#admin-restore", { timeout: 10000 });
  await page.setInputFiles("#admin-restore-key", { name: backup.name, mimeType: "application/json", buffer: Buffer.from(backup.text) });
  await page.fill("#admin-restore-pass", ADMIN_PASS);
  await page.setInputFiles("#admin-restore-file", { name: zip.name, mimeType: "application/zip", buffer: zip.bytes });
  await page.click("#admin-restore");
}

/** Step 6: restore is refused where data/ exists, and works into a second, empty folder. */
async function restoreSmoke(browser, { backup, zip, keyring, usersShown }) {
  const refused = await openAdmin(browser, { "data/users/someone/x.ywb": "" });
  await restoreInto(refused.page, { backup, zip });
  await refused.page.waitForFunction(() => document.getElementById("admin-message")?.textContent !== "", null, { timeout: 30000 }).catch(() => {});
  const said = await message(refused.page);
  const left = await standInFiles(refused.page);
  check("restore: a folder that has data/ is refused in words", said === "This folder already has a data/ folder. Restore only into an empty folder." && !("workspace.json" in left.files), said);
  await refused.context.close();

  const restore = await openAdmin(browser);
  await restoreInto(restore.page, { backup, zip });
  await restore.page.waitForSelector("#admin-workspace", { timeout: 30000 }).catch(() => {});
  const shown = await restore.page.locator("tbody").first().innerText().catch(() => "");
  check("restore: the users table in the second folder matches the original", shown === usersShown && /Harry/.test(shown) && /Sam/.test(shown), `${JSON.stringify(shown)} vs ${JSON.stringify(usersShown)} / ${await message(restore.page)}`);
  await restore.page.waitForTimeout(1500); // a tick, so the status file is written
  const folder = await standInFiles(restore.page);
  const paths = Object.keys(folder.files);
  check(`restore: workspace.json and the table files are written (${folder.kind})`, keyring && (await checkKeyring(keyring, folder.files["workspace.json"] ?? "")) === "ok" && paths.some((p) => p.startsWith("data/") && p.includes("users")), paths.join(", "));
  check("restore: no page errors", restore.errors.length === 0, restore.errors.join(" | "));
  await restore.context.close();
}

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
};
const heading = (page) => page.locator("h1").first().textContent({ timeout: 10000 }).catch((err) => `(${err.message.split("\n")[0]})`);

const OWN_PASS = "my own passport passphrase";

/** Step 4: enrol from an invite made here, reload, unlock; each refusal shows its message; no key in IndexedDB. */
async function passportRun(browser) {
  const random = { bytes: (n) => webcrypto.getRandomValues(new Uint8Array(n)) };
  const b64 = (text) => Buffer.from(text).toString("base64");
  const keyring = newKeyring({ random });
  const invite = await sealKeyFile({ kind: "invite", payload: { ...keyring, user: { id: "sam", name: "Sam Smith" } }, passphrase: INVITE_PASS, random });
  const workspace = await workspaceFileFor(keyring, { random });
  const otherWorkspace = await workspaceFileFor(newKeyring({ random }), { random });
  const rotated = await workspaceFileFor(rotateKeyring(keyring, { random }), { random });

  const context = await browser.newContext();
  const seed = { "folder/app/manifest.json": b64(manifest), [`folder/app/${bundleName}`]: Buffer.from(bundle).toString("base64"), "folder/workspace.json": b64(workspace) };
  const disk = nodeDisk(seed);
  await context.exposeBinding("smokeDiskIo", disk.call);
  await context.addInitScript(fakeDisk);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  const SLOW = { timeout: 30000 }; // each open or seal is 600,000 rounds of PBKDF2
  const shows = (selector) => page.waitForSelector(selector, SLOW).then(() => true, () => false);
  const message = async () => {
    await page.waitForSelector("#message", SLOW).catch(() => {});
    return page.locator("#message").textContent().catch(() => "(no message)");
  };
  const unlockWith = async (passphrase) => {
    await page.fill("#passphrase", passphrase);
    await page.click("#unlock");
  };

  await page.goto(pathToFileURL(join(RELEASE, names.bootstrapFile)).href);
  await page.click("#boot-connect");
  check("enrol: with no passport the app offers an invite or a passport", await shows("#have-invite"));
  await page.click("#have-invite");
  await page.setInputFiles("#invite-file", { name: "sam.invite.json", mimeType: "application/json", buffer: Buffer.from(invite) });
  await page.fill("#invite-passphrase", INVITE_PASS);
  await page.fill("#new-passphrase", OWN_PASS);
  await page.fill("#confirm-passphrase", OWN_PASS);
  await page.click("#open-invite");
  check("enrol: the invite opens and the passport is offered for saving", await shows("#save-passport"), await message());
  await page.click("#save-passport");
  check("enrol: the app starts with the passport's keys", await shows("#items"), await message());
  check("enrol: the passport is saved on the user's side, not in the folder", disk.read("local/sam.passport.json") !== null && disk.read("folder/sam.passport.json") === null);

  await page.reload();
  check("reload: the remembered passport asks for the passphrase", await shows("#passphrase"));
  await unlockWith("not the right passphrase");
  check("a wrong passphrase is refused with its message", (await message()) === "That passphrase does not open this file.", await message());
  await unlockWith(OWN_PASS);
  check("unlock: the app starts again from the passport", await shows("#items"), await message());

  const stored = await page.evaluate(scanIndexedDb);
  check("IndexedDB holds no CryptoKey", stored.cryptoKeys === 0, JSON.stringify(stored));
  check("IndexedDB holds no key file", stored.keyFiles === 0, JSON.stringify(stored));
  check("IndexedDB remembers the passport's handle", stored.passportHandle === "local/sam.passport.json", JSON.stringify(stored));

  for (const [label, text, expected] of [
    ["another workspace", otherWorkspace, "This passport is for a different workspace."],
    ["an out-of-date passport", rotated, "Your passport is out of date. Ask the admin for a new invite."],
  ]) {
    disk.put("folder/workspace.json", b64(text));
    await page.reload();
    await shows("#passphrase");
    await unlockWith(OWN_PASS);
    check(`${label} is refused with its message`, (await message()) === expected, await message());
  }
  check("no page errors in the passport run", errors.length === 0, errors.join(" | "));
  await context.close();
}

const { bundle, manifest, forged } = await buildRelease();
const browser = await chromium.launch();
try {
  const good = await openPage(browser, { "manifest.json": manifest, [bundleName]: bundle });
  await good.page.click("#boot-connect");
  await good.page.waitForSelector("#trellis-shell", { timeout: 10000 }).catch(() => {});
  check("first run: the signed bundle is verified and the app starts", await shellShown(good.page), `${await heading(good.page)} / ${await good.page.locator("#boot-message").textContent().catch(() => "")}`);
  const shown = await good.page.locator("body").innerText();
  check("the app reports the bundle's version", shown.includes(`Version ${version}`));

  await good.page.reload();
  await good.page.waitForSelector("#trellis-shell", { timeout: 10000 }).catch(() => {});
  check("reload: the app starts from the cache without the folder", await shellShown(good.page), await heading(good.page));
  check("no page errors", good.errors.length === 0, good.errors.join(" | "));
  await good.context.close();

  const bad = await openPage(browser, { "manifest.json": forged, [bundleName]: bundle });
  await bad.page.click("#boot-connect");
  await bad.page.waitForFunction(() => document.getElementById("boot-message")?.textContent?.includes("not signed"), null, { timeout: 10000 }).catch(() => {});
  const message = await bad.page.locator("#boot-message").textContent().catch(() => "");
  check("a manifest signed with another key is refused", message.includes("not signed") && (await heading(bad.page)) === names.title && !(await shellShown(bad.page)), message);
  await bad.context.close();

  await passportRun(browser);
  await adminSmoke(browser);
} finally {
  await browser.close();
}
if (checks.includes(false)) process.exit(1);
console.log(`smoke test passed: bootstrap ${readFileSync(join(RELEASE, names.bootstrapFile)).length} bytes, bundle ${bundle.length} bytes`);
