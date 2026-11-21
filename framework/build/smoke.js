// From-disk smoke test (ADR-0005 section 8, step 3; gate G8). Builds the
// bootstrap and the app bundle twice, at versions N and N+1, with one
// throwaway signing key, lays out a release folder, and opens the bootstrap
// page from disk (file://) in headless Chrome:
//
//   1. first run: connect the folder, the signed bundle N is verified and the app starts
//   2. reload: the app starts from the browser's cache, no folder needed
//   3. update: N+1 and its signed manifest are put in the folder while N runs;
//      the update check accepts it, the page says it is ready, and after a
//      reload the app reports N+1
//   4. a forged update: a manifest for N+2 signed with another key is put in
//      the folder; the check refuses it and after a reload N+1 still runs
//   5. no page errors in steps 1 to 4
//   6. first run with a manifest signed with another key: refused, nothing runs
//
// Headless Chrome cannot drive the real folder picker, so the picker is
// replaced by one that returns an in-page stand-in holding the release files.
// The test writes into that stand-in while the page is open, as a sync client
// would write into the real folder. Reading a real folder handle is therefore
// NOT covered here; hashing, signature checks, the IndexedDB cache, the update
// notice and running the bundle are real.
//
// The update check is triggered from the test by calling the checkForUpdate
// the bootstrap hands to the bundle (the loader contract), so the test does
// not wait for the 15-minute recheck. To reach it, the test wraps the module
// URL the bootstrap imports so that start() also records its services; the
// bundle itself is the real build. The app's own call to checkForUpdate,
// made once its host is running on a writable folder, is not exercised.
// Needs Playwright with Chromium installed. Exit code 1 on any failed check.
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { sha256Hex, signManifest } from "../runtime/loader/manifest.js";
import { appNames } from "../runtime/names.ts";
import definition from "./app-definition.js";
import { appConfig } from "./vite.config.js";

const { chromium } = createRequire(import.meta.url)("playwright");
const { subtle } = webcrypto;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(ROOT, "dist", "smoke");
const RELEASE = join(ROOT, "dist", "smoke-release");
const names = appNames(definition);
const APP_HEADING = `${names.title} engine test page`;
const v1 = JSON.parse(readFileSync(join(ROOT, "app", "package.json"), "utf8")).version;
const v2 = v1.replace(/\d+$/, (patch) => String(Number(patch) + 1));
const v3 = v1.replace(/\d+$/, (patch) => String(Number(patch) + 2));

const newKey = () => subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const viteBuild = (mode, version, outDir) => build({ configFile: false, logLevel: "warn", mode, ...appConfig({ definition, version, mode, outDir }) });

/** A manifest whose stable channel points at the last of `versions`; `bundles` maps version to bytes. */
async function manifestFor({ serial, versions, bundles, privateKey }) {
  const listed = {};
  for (const version of versions) listed[version] = { file: names.bundleFile(version), sha256: await sha256Hex(bundles[version], subtle), minBootstrap: 1 };
  const body = { format: 1, serial, channels: { stable: versions.at(-1) }, bundles: listed };
  return signManifest({ body, privateKey, subtle });
}

async function buildReleases() {
  const admin = await newKey();
  const other = await newKey();
  process.env.TRELLIS_PUBLIC_KEY = JSON.stringify(await subtle.exportKey("jwk", admin.publicKey));
  rmSync(DIST, { recursive: true, force: true });
  await viteBuild("bootstrap", v1, DIST);
  for (const version of [v1, v2]) await viteBuild("app", version, join(DIST, version));
  const bundles = Object.fromEntries([v1, v2].map((version) => [version, readFileSync(join(DIST, version, "app", names.bundleFile(version)))]));
  // N+2 is never built: the forged manifest is refused before its bundle is read,
  // so N+1's bytes stand in for it and the hash in the manifest is correct.
  bundles[v3] = bundles[v2];

  rmSync(RELEASE, { recursive: true, force: true });
  mkdirSync(join(RELEASE, "app"), { recursive: true });
  copyFileSync(join(DIST, "bootstrap.html"), join(RELEASE, names.bootstrapFile));
  copyFileSync(join(DIST, v1, "app", names.bundleFile(v1)), join(RELEASE, "app", names.bundleFile(v1)));
  const first = await manifestFor({ serial: 1, versions: [v1], bundles, privateKey: admin.privateKey });
  writeFileSync(join(RELEASE, "app", "manifest.json"), first);
  return {
    bundles,
    first,
    update: await manifestFor({ serial: 2, versions: [v1, v2], bundles, privateKey: admin.privateKey }),
    forgedUpdate: await manifestFor({ serial: 3, versions: [v1, v2, v3], bundles, privateKey: other.privateKey }),
    forgedFirst: await manifestFor({ serial: 1, versions: [v1], bundles, privateKey: other.privateKey }),
  };
}

/**
 * Runs in the page before its own scripts: the folder picker returns an
 * in-page folder holding these files (read-only to the page: app/<name>). Such
 * an object cannot be kept in IndexedDB as a real handle can, so the page's
 * attempt to remember it stores nothing instead. Each load starts from these
 * files; the test adds more with window.__smokeFolder.put.
 *
 * It also wraps the bundle's module URL so that start() records the services
 * the bootstrap passes (window.__smokeServices). The bootstrap's only
 * JavaScript Blob is the bundle it runs.
 */
function fakePicker({ files }) {
  const create = URL.createObjectURL;
  URL.createObjectURL = function (blob) {
    const url = create.call(URL, blob);
    if (!(blob instanceof Blob) || blob.type !== "text/javascript") return url;
    const wrapper = `import * as bundle from ${JSON.stringify(url)};\nexport function start(services) { window.__smokeServices = services; return bundle.start(services); }`;
    return create.call(URL, new Blob([wrapper], { type: "text/javascript" }));
  };
  const missing = () => { throw new DOMException("not found", "NotFoundError"); };
  const fileHandle = (base64) => ({
    kind: "file",
    getFile: async () => new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))]),
  });
  const app = { kind: "directory", name: "app", getFileHandle: async (name) => (name in files ? fileHandle(files[name]) : missing()) };
  const root = { kind: "directory", name: "smoke-folder", fake: true, getDirectoryHandle: async (name) => (name === "app" ? app : missing()) };
  window.showDirectoryPicker = async () => root;
  window.__smokeFolder = { root, put: (more) => void Object.assign(files, more) };
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    return put.call(this, value?.fake ? undefined : value, key);
  };
}

const base64 = (files) => Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, Buffer.from(bytes).toString("base64")]));

async function openPage(browser, files) {
  const context = await browser.newContext();
  await context.addInitScript(fakePicker, { files: base64(files) });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(pathToFileURL(join(RELEASE, names.bootstrapFile)).href);
  return { context, page, errors };
}

/** Put files into the page's folder stand-in, as a sync client would. */
const putFiles = (page, files) => page.evaluate((encoded) => window.__smokeFolder.put(encoded), base64(files)).catch((err) => console.log(`     could not write to the folder: ${err.message.split("\n")[0]}`));
/** Run the update check the bootstrap gave the bundle, on the folder stand-in. */
const checkNow = (page) => page.evaluate(() => window.__smokeServices.checkForUpdate(window.__smokeFolder.root)).catch((err) => ({ status: "error", message: err.message.split("\n")[0] }));

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
};
const heading = (page) => page.locator("h1").first().textContent({ timeout: 10000 }).catch((err) => `(${err.message.split("\n")[0]})`);
const notice = (page) => page.locator("#boot-notice").textContent({ timeout: 10000 }).catch(() => "(no notice)");
/** The page shows `version` and the bootstrap started the bundle as `version` (N+2's stand-in bytes show N+1). */
const reportsVersion = async (page, version) =>
  (await page.locator("body").innerText()).includes(`Version ${version},`) && (await page.evaluate(() => window.__smokeServices?.version ?? null)) === version;
const reloadFromCache = async (page) => {
  await page.reload();
  await page.waitForSelector("#boot-connect", { state: "detached", timeout: 10000 }).catch(() => {});
};

const releases = await buildReleases();
const { bundles } = releases;
const browser = await chromium.launch();
try {
  const good = await openPage(browser, { "manifest.json": releases.first, [names.bundleFile(v1)]: bundles[v1] });
  await good.page.click("#boot-connect");
  await good.page.waitForSelector("#boot", { state: "detached", timeout: 10000 }).catch(() => {});
  check("first run: the signed bundle is verified and the app starts", (await heading(good.page)) === APP_HEADING, `${await heading(good.page)} / ${await good.page.locator("#boot-message").textContent().catch(() => "")}`);
  check(`the app reports the bundle's version (${v1})`, await reportsVersion(good.page, v1));

  await reloadFromCache(good.page);
  check("reload: the app starts from the cache without the folder", (await heading(good.page)) === APP_HEADING, await heading(good.page));

  await putFiles(good.page, { "manifest.json": releases.update, [names.bundleFile(v1)]: bundles[v1], [names.bundleFile(v2)]: bundles[v2] });
  const updated = await checkNow(good.page);
  const ready = await notice(good.page);
  check(`update: ${v2} in the folder is accepted and the page says it is ready`, updated.status === "updated" && updated.version === v2 && ready.includes(`Version ${v2} is ready.`), `${JSON.stringify(updated)} / ${ready}`);
  await Promise.all([good.page.waitForEvent("load", { timeout: 10000 }), good.page.locator("#boot-notice button").click({ timeout: 10000 })]).catch(() => {});
  check(`update: after "Load it" the app reports ${v2}`, (await heading(good.page)) === APP_HEADING && (await reportsVersion(good.page, v2)), await heading(good.page));

  await putFiles(good.page, { "manifest.json": releases.forgedUpdate, [names.bundleFile(v1)]: bundles[v1], [names.bundleFile(v2)]: bundles[v2], [names.bundleFile(v3)]: bundles[v3] });
  const forged = await checkNow(good.page);
  const refused = await notice(good.page);
  check(`forged update: a manifest for ${v3} signed with another key is refused`, forged.status === "rejected" && forged.code === "signature-invalid" && refused.includes("not signed"), `${JSON.stringify(forged)} / ${refused}`);
  await reloadFromCache(good.page);
  check(`forged update: after a reload the app still reports ${v2}`, (await heading(good.page)) === APP_HEADING && (await reportsVersion(good.page, v2)), await heading(good.page));
  check("no page errors", good.errors.length === 0, good.errors.join(" | "));
  await good.context.close();

  const bad = await openPage(browser, { "manifest.json": releases.forgedFirst, [names.bundleFile(v1)]: bundles[v1] });
  await bad.page.click("#boot-connect");
  await bad.page.waitForFunction(() => document.getElementById("boot-message")?.textContent?.includes("not signed"), null, { timeout: 10000 }).catch(() => {});
  const message = await bad.page.locator("#boot-message").textContent().catch(() => "");
  check("first run: a manifest signed with another key is refused", message.includes("not signed") && (await heading(bad.page)) === names.title, message);
  await bad.context.close();
} finally {
  await browser.close();
}
if (checks.includes(false)) process.exit(1);
console.log(`smoke test passed: bootstrap ${readFileSync(join(RELEASE, names.bootstrapFile)).length} bytes, bundles ${bundles[v1].length} and ${bundles[v2].length} bytes`);
