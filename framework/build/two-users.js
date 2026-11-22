// Two-user test from built files (S4 Deliver 5; gate G7 builds on it). Builds
// the bootstrap and the app bundle with a throwaway signing key, puts the
// signed release into a stand-in shared folder (stand-in-folder.js), and opens
// the bootstrap page from disk (file://) in two browser contexts. Each context
// has its own IndexedDB, so the two pages are two devices with two users. The
// folder holds a workspace.json made here; each user has a passport for it,
// sealed here as enrolling would seal it, and unlocks with its passphrase.
//
//   1. both connect to the folder, open their passports and start the app
//   2. A types in the shared note and saves; B reads the folder and shows it
//   3. the same from B to A
//   4. the folder is partitioned, both type and save, neither sees the other;
//      the partition heals and both end with the same text, which keeps both
//      edits (the note is a merged-text field, spec S2)
//
// Saving and reading are driven by the diagnostics view's "Save now" and "Read
// folder now" (opened from the health menu), not by waiting for timers.
//
// NOT covered: the real folder and file pickers (headless Chrome cannot drive
// them, so they are replaced by ones returning the stand-in and the passport) and a real synced folder (the
// stand-in is a local directory; a sync client's delays, conflict copies and
// placeholders are not reproduced). Reading a real folder handle and keeping
// it in IndexedDB are also not covered. Hashing, signature checks, the
// IndexedDB cache, the engine and the app are real.
// Needs Playwright with Chromium installed. Exit code 1 on any failed check.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Hex, signManifest } from "../runtime/loader/manifest.js";
import { newKeyring } from "../runtime/identity/admin.js";
import { sealKeyFile } from "../runtime/identity/keyfile.js";
import { workspaceFileFor } from "../runtime/identity/workspace.js";
import { appNames } from "../runtime/names.ts";
import definition from "./app-definition.js";
import { createStandInFolder } from "./stand-in-folder.js";

const { chromium } = createRequire(import.meta.url)("playwright");
const { subtle } = webcrypto;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VITE_CONFIG = join(ROOT, "framework", "build", "vite.config.js");
const DIST = join(ROOT, "dist");
const RELEASE = join(DIST, "two-users-release");
const version = JSON.parse(readFileSync(join(ROOT, "app", "package.json"), "utf8")).version;
const names = appNames(definition);
const bundleName = names.bundleFile(version);
const SYNC_TIMEOUT_MS = 15000;
const SLOW = { timeout: 30000 }; // unlocking a passport is 600,000 rounds of PBKDF2
const random = { bytes: (n) => webcrypto.getRandomValues(new Uint8Array(n)) };

/** The same release folder the smoke test lays out: bootstrap page, bundle, signed manifest. */
async function buildRelease() {
  const admin = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
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
  writeFileSync(join(RELEASE, "app", "manifest.json"), await signManifest({ body, privateKey: admin.privateKey, subtle }));
}

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
};

/**
 * Runs in the page before its own scripts: the open picker returns this
 * user's passport. Marked standIn, so the page's attempt to remember the
 * handle stores nothing, as for the folder.
 */
function passportPicker({ name, text }) {
  const handle = { kind: "file", name, standIn: true, queryPermission: async () => "granted", requestPermission: async () => "granted", getFile: async () => new File([text], name) };
  window.showOpenFilePicker = async () => [handle];
}

/** One user: a browser context of its own, connected through the bootstrap and unlocked from its passport. */
async function openUser(browser, folder, label, user) {
  const context = await browser.newContext();
  await folder.attach(context, label);
  await context.addInitScript(passportPicker, { name: `${user.id}.passport.json`, text: user.passportText });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(`${label}: ${err}`));
  await page.goto(pathToFileURL(join(RELEASE, names.bootstrapFile)).href);
  await page.click("#boot-connect");
  await page.waitForSelector("#boot", { state: "detached", timeout: 10000 });
  await page.getByRole("button", { name: "Choose the shared folder" }).click();
  await page.click("#have-passport");
  await page.fill("#passphrase", user.passphrase);
  await page.click("#unlock");
  await page.waitForSelector("#note", SLOW);
  return { label, page, errors };
}

/** A workspace in the stand-in folder and a passport for each user, as the admin page and enrolling would make them. */
async function makeWorkspace(folder, people) {
  const keyring = newKeyring({ random });
  writeFileSync(join(folder.dir, "workspace.json"), await workspaceFileFor(keyring, { random }));
  return Promise.all(people.map(async ({ id, name }) => {
    const passphrase = `${id}'s own passport phrase`;
    const passportText = await sealKeyFile({ kind: "passport", payload: { ...keyring, user: { id, name } }, passphrase, random });
    return { id, passphrase, passportText };
  }));
}

const note = (u) => u.page.inputValue("#note");
/** Opens the diagnostics view from the health menu, presses `name`, and closes it again (it is modal). */
async function diagnostics(u, name) {
  await u.page.locator("#connection > button").click();
  await u.page.getByRole("menuitem", { name: "Diagnostics" }).click();
  await u.page.getByRole("button", { name }).click();
  await u.page.getByRole("button", { name: "Close" }).click();
}
const save = (u) => diagnostics(u, "Save now");
const read = (u) => diagnostics(u, "Read folder now");

/** "Read folder now" on `u` until its note shows `expected` (the save on the other page may still be finishing). */
async function readUntil(u, expected, timeoutMs = SYNC_TIMEOUT_MS) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await read(u);
    if (await u.page.waitForFunction((text) => document.querySelector("#note")?.value === text, expected, { timeout: 500 }).then(() => true, () => false)) return true;
  }
  return false;
}

/** Save and read on both pages until their notes agree. */
async function settle(a, b) {
  const end = Date.now() + SYNC_TIMEOUT_MS;
  while (Date.now() < end) {
    await save(a);
    await save(b);
    await read(a);
    await read(b);
    await a.page.waitForTimeout(250);
    if ((await note(a)) === (await note(b))) return true;
  }
  return false;
}

await buildRelease();
const folder = await createStandInFolder();
cpSync(join(RELEASE, "app"), join(folder.dir, "app"), { recursive: true });
const [alice, bob] = await makeWorkspace(folder, [{ id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }]);
const browser = await chromium.launch();
try {
  const A = await openUser(browser, folder, "A", alice);
  const B = await openUser(browser, folder, "B", bob);
  check("both users connect to the folder and start the app", true);

  await A.page.fill("#note", "Hello from alice");
  await save(A);
  check("A to B: B shows the note A saved", await readUntil(B, "Hello from alice"), await note(B));

  await B.page.fill("#note", "Hello from bob");
  await save(B);
  check("B to A: A shows the note B saved", await readUntil(A, "Hello from bob"), await note(A));

  await folder.partition(true);
  await A.page.fill("#note", "alice while apart");
  await B.page.fill("#note", "bob while apart");
  await save(A);
  await save(B);
  const aApart = !(await readUntil(A, "bob while apart", 3000));
  const bApart = !(await readUntil(B, "alice while apart", 3000));
  check("while partitioned neither sees the other's change", aApart && bApart, `A "${await note(A)}", B "${await note(B)}"`);

  await folder.partition(false);
  const agreed = await settle(A, B);
  const [a, b] = [await note(A), await note(B)];
  const merged = ["alice while apartbob while apart", "bob while apartalice while apart"].includes(a);
  check("after healing both end with the same text, keeping both edits", agreed && merged, `A "${a}", B "${b}"`);

  const errors = [...A.errors, ...B.errors];
  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  await folder.close();
}
if (checks.includes(false)) process.exit(1);
console.log("two-user test passed");
