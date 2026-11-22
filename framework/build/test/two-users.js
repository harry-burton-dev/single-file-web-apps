// Two-user test from built files (S4 Deliver 5, gate G7). It lives under test/
// because it drives the example app by its table and field names, which gate G4
// keeps out of framework source. Builds the
// bootstrap and the app bundle with a throwaway signing key, puts the signed
// release into a stand-in shared folder (stand-in-folder.js), and opens the
// bootstrap page from disk (file://) in two browser contexts. Each context has
// its own IndexedDB, so the two pages are two devices with two users. Here in
// Node the admin's operations make the workspace.json and one invite per user;
// each page accepts its invite (picked with setInputFiles) and saves a passport.
//
//   1. both connect to the folder, accept their invites and start the example app
//   2. A adds an item; B reads the folder and shows it
//   3. B edits its title; A shows the new title
//   4. the folder is partitioned and A and B each set a different owner (an
//      "ask" field); neither sees the other's; the partition heals
//   5. both show the shell's conflict prompt with both values
//   6. A keeps one; B's prompt clears and both show that owner
//   7. both pages list the same items with the same values
//
// Saving and reading are driven by the diagnostics view's "Save now" and "Read
// folder now" (opened from the health menu), not by waiting for timers.
//
// NOT covered: the real folder and file pickers (headless Chrome cannot drive
// them, so the folder picker returns the stand-in and the save picker keeps the
// passport in the page) and a real synced folder (the stand-in is a local
// directory; a sync client's delays, conflict copies and placeholders are not
// reproduced). Reading a real folder handle and keeping it in IndexedDB are
// also not covered. Hashing, signature checks, the IndexedDB cache, enrolling,
// the engine, the shell and the app are real.
//
// `--release <folder>` skips the build and runs against a release folder made
// elsewhere, such as the <name>/ folder unzipped from a GitHub Release (gate
// G13). Its bootstrap and signed manifest are used as they are.
// Needs Playwright with Chromium installed. Exit code 1 on any failed check.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Hex, signManifest } from "../../runtime/loader/manifest.js";
import { mintInvite, newKeyring } from "../../runtime/identity/admin.js";
import { workspaceFileFor } from "../../runtime/identity/workspace.js";
import { appNames } from "../../runtime/names.ts";
import definition from "../app-definition.js";
import { createStandInFolder } from "../stand-in-folder.js";

const { chromium } = createRequire(import.meta.url)("playwright");
const { subtle } = webcrypto;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VITE_CONFIG = join(ROOT, "framework", "build", "vite.config.js");
const DIST = join(ROOT, "dist");
const { values: args } = parseArgs({ options: { release: { type: "string" } } });
const RELEASE = args.release ? resolve(args.release) : join(DIST, "two-users-release");
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
 * Runs in the page before its own scripts: the save picker keeps the passport
 * in the page (on this user's side, never in the shared folder). Marked standIn,
 * so the page's attempt to remember the handle stores nothing, as for the folder.
 */
function passportSaver() {
  window.savedPassports = {};
  window.showSaveFilePicker = async ({ suggestedName }) => ({
    kind: "file",
    name: suggestedName,
    standIn: true,
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
    getFile: async () => new File([window.savedPassports[suggestedName] ?? ""], suggestedName),
    createWritable: async () => {
      let text = "";
      return { write: async (data) => { text += data; }, close: async () => { window.savedPassports[suggestedName] = text; } };
    },
  });
}

const INVITE_PASS = "the admin's one-time invite phrase";

/** A workspace in the stand-in folder and an invite for each user, as the admin page makes them. */
async function makeWorkspace(folder, people) {
  const keyring = newKeyring({ random });
  writeFileSync(join(folder.dir, "workspace.json"), await workspaceFileFor(keyring, { random }));
  return Promise.all(people.map(async (user) => ({ ...user, inviteText: await mintInvite({ keyring, user, passphrase: INVITE_PASS, random }) })));
}

/** One user: a browser context of its own, connected through the bootstrap, enrolled from its invite. */
async function openUser(browser, folder, label, user) {
  const context = await browser.newContext();
  await folder.attach(context, label);
  await context.addInitScript(passportSaver);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(`${label}: ${err}`));
  await page.goto(pathToFileURL(join(RELEASE, names.bootstrapFile)).href);
  await page.click("#boot-connect");
  await page.waitForSelector("#boot", { state: "detached", timeout: 10000 });
  await page.getByRole("button", { name: "Choose the shared folder" }).click();
  await page.click("#have-invite");
  await page.setInputFiles("#invite-file", { name: `${user.id}.invite.json`, mimeType: "application/json", buffer: Buffer.from(user.inviteText) });
  await page.fill("#invite-passphrase", INVITE_PASS);
  const own = `${user.id}'s own passport phrase`;
  await page.fill("#new-passphrase", own);
  await page.fill("#confirm-passphrase", own);
  await page.click("#open-invite");
  await page.click("#save-passport", SLOW);
  await page.waitForSelector("#items", SLOW);
  const saved = await page.evaluate(() => Object.keys(window.savedPassports));
  return { label, page, errors, saved };
}

/** What a page shows: every item's fields, in list order, and the conflict prompt's count ("" when none). */
const shown = (u) =>
  u.page.evaluate(() => ({
    items: [...document.querySelectorAll("#item-list > li")].map((li) => {
      const at = (part) => document.getElementById(`${li.id}-${part}`);
      return { id: li.dataset.id, title: at("title").value, done: at("done").checked, owner: at("owner").value, notes: at("notes").value };
    }),
    conflicts: document.querySelector("#conflicts > button")?.textContent ?? "",
  }));
const describe = async (u) => JSON.stringify(await shown(u));

/** Opens the diagnostics view from the health menu, presses `name`, and closes it again (it is modal). */
async function diagnostics(u, name) {
  await u.page.locator("#connection > button").click();
  await u.page.getByRole("menuitem", { name: "Diagnostics" }).click();
  const dialog = u.page.getByRole("dialog");
  await dialog.getByRole("button", { name }).click();
  await dialog.getByRole("button", { name: "Close" }).click();
}
const save = (u) => diagnostics(u, "Save now");
const read = (u) => diagnostics(u, "Read folder now");

/** "Read folder now" on `u` until what it shows passes `test` (the save on the other page may still be finishing). */
async function readUntil(u, test, timeoutMs = SYNC_TIMEOUT_MS) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await read(u);
    await u.page.waitForTimeout(250);
    if (test(await shown(u))) return true;
  }
  return false;
}

/** Save and read on both pages until `test` passes on both. */
async function settle(a, b, test) {
  const end = Date.now() + SYNC_TIMEOUT_MS;
  while (Date.now() < end) {
    await save(a);
    await save(b);
    await read(a);
    await read(b);
    await a.page.waitForTimeout(250);
    if (test(await shown(a), await shown(b))) return true;
  }
  return false;
}

/** Opens the conflict prompt and returns the "Keep ..." choices it offers. */
async function openPrompt(u) {
  const toggle = u.page.locator("#conflicts > button");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  return u.page.getByRole("button", { name: /^Keep "/ }).allTextContents();
}

const item = (view, id) => view.items.find((i) => i.id === id);

if (!args.release) await buildRelease();
const folder = await createStandInFolder();
cpSync(join(RELEASE, "app"), join(folder.dir, "app"), { recursive: true });
const [alice, bob] = await makeWorkspace(folder, [{ id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }]);
const browser = await chromium.launch();
try {
  const A = await openUser(browser, folder, "A", alice);
  const B = await openUser(browser, folder, "B", bob);
  check("both users accept their invites, connect to the folder and start the app", true);
  check("each passport is saved on its user's side", A.saved.join() === "alice.passport.json" && B.saved.join() === "bob.passport.json", `${A.saved} / ${B.saved}`);

  await A.page.fill("#new-item-title", "Buy milk");
  await A.page.click("#add-item-button");
  await A.page.waitForSelector("#item-list > li");
  const id = (await shown(A)).items[0].id;
  await save(A);
  check("A to B: B shows the item A added", await readUntil(B, (v) => item(v, id)?.title === "Buy milk"), await describe(B));

  await B.page.fill(`#item-${id}-title`, "Buy oat milk");
  await save(B);
  check("B to A: A shows the title B edited", await readUntil(A, (v) => item(v, id)?.title === "Buy oat milk"), await describe(A));

  await folder.partition(true);
  await A.page.fill(`#item-${id}-owner`, "alice");
  await B.page.fill(`#item-${id}-owner`, "bob");
  await save(A);
  await save(B);
  const aApart = !(await readUntil(A, (v) => item(v, id)?.owner === "bob", 3000));
  const bApart = !(await readUntil(B, (v) => item(v, id)?.owner === "alice", 3000));
  check("while partitioned neither sees the other's owner", aApart && bApart, `${await describe(A)} / ${await describe(B)}`);

  await folder.partition(false);
  const both = (test) => (a, b) => test(a) && test(b);
  const prompted = await settle(A, B, both((v) => v.conflicts === "1 needs a decision"));
  check("after healing both show the conflict prompt", prompted, `${await describe(A)} / ${await describe(B)}`);
  const choices = [(await openPrompt(A)).sort(), (await openPrompt(B)).sort()];
  const expected = JSON.stringify(['Keep "alice"', 'Keep "bob"']);
  check("both prompts offer both owners", choices.every((c) => JSON.stringify(c) === expected), JSON.stringify(choices));

  await A.page.getByRole("button", { name: 'Keep "alice"' }).click();
  const resolved = await settle(A, B, both((v) => v.conflicts === "" && item(v, id)?.owner === "alice"));
  check("A keeps alice: B's prompt clears and both show owner alice", resolved, `${await describe(A)} / ${await describe(B)}`);

  const [a, b] = [await shown(A), await shown(B)];
  check("both pages list the same items with the same values", JSON.stringify(a) === JSON.stringify(b) && a.items.length === 1, `${JSON.stringify(a)} / ${JSON.stringify(b)}`);

  const errors = [...A.errors, ...B.errors];
  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  await folder.close();
}
if (checks.includes(false)) process.exit(1);
console.log("two-user test passed");
