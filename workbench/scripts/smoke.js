// From-disk smoke test (ADR-0005 section 8, step 3). Builds the bootstrap and
// the app bundle with a throwaway signing key, lays out a release folder, and
// opens workbench.html from disk (file://) in headless Chrome:
//
//   1. first run: connect the folder, the signed bundle is verified and the app starts
//   2. reload: the app starts from the browser's cache, no folder needed
//   3. a manifest signed with another key is refused and nothing runs
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
import { sha256Hex, signManifest } from "../src/loader/manifest.js";

const { chromium } = createRequire(import.meta.url)("playwright");
const { subtle } = webcrypto;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const RELEASE = join(DIST, "smoke-release");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const bundleName = `app-${version}.js`;
const APP_HEADING = "Workbench engine test page";

const newKey = () => subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

async function buildRelease() {
  const admin = await newKey();
  const publicJwk = JSON.stringify(await subtle.exportKey("jwk", admin.publicKey));
  const vite = (mode) => execFileSync("npx", ["vite", "build", "--mode", mode], { cwd: ROOT, stdio: "inherit", env: { ...process.env, WORKBENCH_PUBLIC_KEY: publicJwk } });
  vite("bootstrap");
  vite("app");
  rmSync(RELEASE, { recursive: true, force: true });
  mkdirSync(join(RELEASE, "app"), { recursive: true });
  copyFileSync(join(DIST, "workbench.html"), join(RELEASE, "workbench.html"));
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
  await page.goto(pathToFileURL(join(RELEASE, "workbench.html")).href);
  return { context, page, errors };
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
  check("a manifest signed with another key is refused", message.includes("not signed") && (await heading(bad.page)) === "Workbench", message);
  await bad.context.close();
} finally {
  await browser.close();
}
if (checks.includes(false)) process.exit(1);
console.log(`smoke test passed: bootstrap ${readFileSync(join(RELEASE, "workbench.html")).length} bytes, bundle ${bundle.length} bytes`);
