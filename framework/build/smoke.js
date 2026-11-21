// From-disk smoke test (ADR-0005 section 8, step 3). Builds the bootstrap and
// the app bundle with a throwaway signing key, lays out a release folder, and
// opens the bootstrap page from disk (file://) in headless Chrome:
//
//   1. first run: connect the folder, the signed bundle is verified and the app starts
//   2. reload: the app starts from the browser's cache, no folder needed
//   3. a manifest signed with another key is refused and nothing runs
//   4. the admin page (OUT-10), also from disk: creates a workspace in a
//      stand-in folder, and reopens it from the downloaded key backup
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
import { openBackup } from "../runtime/identity/admin.js";
import { checkKeyring } from "../runtime/identity/workspace.js";
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
const APP_HEADING = `${names.title} engine test page`;

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

/** Clicks and returns the downloaded file's name and text. */
async function downloadFrom(page, selector) {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), page.click(selector)]);
  return { name: download.suggestedFilename(), text: readFileSync(await download.path(), "utf8") };
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
  check("admin: no page errors while creating", create.errors.length === 0, create.errors.join(" | "));
  await create.context.close();

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

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
};
const heading = (page) => page.locator("h1").first().textContent({ timeout: 10000 }).catch((err) => `(${err.message.split("\n")[0]})`);

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

  await adminSmoke(browser);
} finally {
  await browser.close();
}
if (checks.includes(false)) process.exit(1);
console.log(`smoke test passed: bootstrap ${readFileSync(join(RELEASE, names.bootstrapFile)).length} bytes, bundle ${bundle.length} bytes`);
