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
import { workspaceFileFor } from "../runtime/identity/workspace.js";
import { handMadeKeyring } from "../runtime/test/identity/_keyring.js";
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
const APP_HEADING = `${names.title} engine test page`;

const newKey = () => subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

async function buildRelease() {
  const admin = await newKey();
  const publicJwk = JSON.stringify(await subtle.exportKey("jwk", admin.publicKey));
  const vite = (mode) => execFileSync("npx", ["vite", "build", "--config", VITE_CONFIG, "--mode", mode], { cwd: ROOT, stdio: "inherit", env: { ...process.env, TRELLIS_PUBLIC_KEY: publicJwk } });
  vite("bootstrap");
  vite("app");
  rmSync(RELEASE, { recursive: true, force: true });
  mkdirSync(join(RELEASE, "app"), { recursive: true });
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
 * Runs in the page before its own scripts, for step 4: a writable in-page
 * disk kept in sessionStorage so it survives a reload. "folder/" is the shared
 * folder the folder picker returns; "local/" is where the save picker puts the
 * passport. Such handles cannot be kept in IndexedDB as real ones can, so a
 * stored handle is replaced by a marker and brought back when read.
 */
function fakeDisk({ seed }) {
  const PREFIX = "smoke-disk:";
  let tick = Date.now();
  const toB64 = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const read = (path) => JSON.parse(sessionStorage.getItem(PREFIX + path) ?? "null");
  const put = (path, b64) => sessionStorage.setItem(PREFIX + path, JSON.stringify({ b64, mtime: ++tick }));
  const notFound = () => { throw new DOMException("not found", "NotFoundError"); };
  const granted = { queryPermission: async () => "granted", requestPermission: async () => "granted" };
  const bytesOf = (data) => (typeof data === "string" ? new TextEncoder().encode(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data));
  const isDir = (path) => sessionStorage.getItem(`${PREFIX}dir:${path}`) !== null;
  const children = (path) => Object.keys(sessionStorage).filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length)).map((k) => (k.startsWith("dir:") ? { dir: true, p: k.slice(4) } : { dir: false, p: k })).filter(({ p }) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"));
  const file = (path) => ({
    ...granted, kind: "file", name: path.split("/").pop(), fake: path,
    getFile: async () => { const v = read(path) ?? notFound(); return new File([fromB64(v.b64)], path.split("/").pop(), { lastModified: v.mtime }); },
    createWritable: async () => {
      const parts = [];
      return { write: async (data) => void parts.push(...bytesOf(data)), close: async () => put(path, toB64(parts)), abort: async () => undefined };
    },
  });
  const dir = (path) => ({
    ...granted, kind: "directory", name: path === "folder" ? "smoke-folder" : path.split("/").pop(), fake: `dir:${path}`,
    getDirectoryHandle: async (name, { create = false } = {}) => {
      const p = `${path}/${name}`;
      if (!isDir(p)) { if (!create) notFound(); sessionStorage.setItem(`${PREFIX}dir:${p}`, "1"); }
      return dir(p);
    },
    getFileHandle: async (name, { create = false } = {}) => {
      const p = `${path}/${name}`;
      if (!read(p)) { if (!create) notFound(); put(p, ""); }
      return file(p);
    },
    async *entries() { for (const c of children(path)) yield [c.p.split("/").pop(), c.dir ? dir(c.p) : file(c.p)]; },
    removeEntry: async (name) => { sessionStorage.removeItem(PREFIX + `${path}/${name}`); sessionStorage.removeItem(`${PREFIX}dir:${path}/${name}`); },
  });
  if (!sessionStorage.getItem(`${PREFIX}seeded`)) {
    for (const [path, b64] of Object.entries(seed)) {
      put(path, b64);
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) sessionStorage.setItem(`${PREFIX}dir:${parts.slice(0, i).join("/")}`, "1");
    }
    sessionStorage.setItem(`${PREFIX}seeded`, "1");
  }
  window.smokeDisk = { put };
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

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
};
const heading = (page) => page.locator("h1").first().textContent({ timeout: 10000 }).catch((err) => `(${err.message.split("\n")[0]})`);

const INVITE_PASS = "the admin's one-time phrase";
const OWN_PASS = "my own passport passphrase";

/** Step 4: enrol from an invite made here, reload, unlock; each refusal shows its message; no key in IndexedDB. */
async function passportRun(browser) {
  const random = { bytes: (n) => webcrypto.getRandomValues(new Uint8Array(n)) };
  const b64 = (text) => Buffer.from(text).toString("base64");
  const keyring = handMadeKeyring(random);
  const invite = await sealKeyFile({ kind: "invite", payload: { ...keyring, user: { id: "sam", name: "Sam Smith" } }, passphrase: INVITE_PASS, random });
  const workspace = await workspaceFileFor(keyring, { random });
  const otherWorkspace = await workspaceFileFor(handMadeKeyring(random), { random });
  const rotated = await workspaceFileFor({ ...keyring, current: 2, keys: [...keyring.keys, { id: 2, raw: random.bytes(32) }] }, { random });

  const context = await browser.newContext();
  const seed = { "folder/app/manifest.json": b64(manifest), [`folder/app/${bundleName}`]: Buffer.from(bundle).toString("base64"), "folder/workspace.json": b64(workspace) };
  await context.addInitScript(fakeDisk, { seed });
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
  check("enrol: the app starts with the passport's keys", await shows("#note"), await message());
  const saved = await page.evaluate(() => sessionStorage.getItem("smoke-disk:local/sam.passport.json"));
  check("enrol: the passport is saved on the user's side, not in the folder", saved !== null);

  await page.reload();
  check("reload: the remembered passport asks for the passphrase", await shows("#passphrase"));
  await unlockWith("not the right passphrase");
  check("a wrong passphrase is refused with its message", (await message()) === "That passphrase does not open this file.", await message());
  await unlockWith(OWN_PASS);
  check("unlock: the app starts again from the passport", await shows("#note"), await message());

  const stored = await page.evaluate(scanIndexedDb);
  check("IndexedDB holds no CryptoKey", stored.cryptoKeys === 0, JSON.stringify(stored));
  check("IndexedDB holds no key file", stored.keyFiles === 0, JSON.stringify(stored));
  check("IndexedDB remembers the passport's handle", stored.passportHandle === "local/sam.passport.json", JSON.stringify(stored));

  for (const [label, text, expected] of [
    ["another workspace", otherWorkspace, "This passport is for a different workspace."],
    ["an out-of-date passport", rotated, "Your passport is out of date. Ask the admin for a new invite."],
  ]) {
    await page.evaluate((content) => window.smokeDisk.put("folder/workspace.json", content), b64(text));
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
  await good.page.waitForSelector("#boot", { state: "detached", timeout: 10000 }).catch(() => {});
  check("first run: the signed bundle is verified and the app starts", (await heading(good.page)) === APP_HEADING, `${await heading(good.page)} / ${await good.page.locator("#boot-message").textContent().catch(() => "")}`);
  const shown = await good.page.locator("body").innerText();
  check("the app reports the bundle's version", shown.includes(`Version ${version}`));

  await good.page.reload();
  await good.page.waitForSelector("#boot-connect", { state: "detached", timeout: 10000 }).catch(() => {});
  check("reload: the app starts from the cache without the folder", (await heading(good.page)) === APP_HEADING, await heading(good.page));
  check("no page errors", good.errors.length === 0, good.errors.join(" | "));
  await good.context.close();

  const bad = await openPage(browser, { "manifest.json": forged, [bundleName]: bundle });
  await bad.page.click("#boot-connect");
  await bad.page.waitForFunction(() => document.getElementById("boot-message")?.textContent?.includes("not signed"), null, { timeout: 10000 }).catch(() => {});
  const message = await bad.page.locator("#boot-message").textContent().catch(() => "");
  check("a manifest signed with another key is refused", message.includes("not signed") && (await heading(bad.page)) === names.title, message);
  await bad.context.close();

  await passportRun(browser);
} finally {
  await browser.close();
}
if (checks.includes(false)) process.exit(1);
console.log(`smoke test passed: bootstrap ${readFileSync(join(RELEASE, names.bootstrapFile)).length} bytes, bundle ${bundle.length} bytes`);
