// The release manifest keeps history, and a rollback is a manifest change
// (ADR-0005 section 9). Each release copies the previous manifest's bundles
// forward, after checking its signature; `--rollback <version>` signs a new
// manifest pointing stable at a version already listed, and builds nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importPublicKey, sha256Hex, signManifest, validateBody, verifyManifest } from "../runtime/loader/manifest.js";
import { releaseBody, rollbackBody } from "../build/release-manifest.js";
import { appNames } from "../runtime/names.ts";
import definition from "../build/app-definition.js";

const { subtle } = webcrypto;
const repo = fileURLToPath(new URL("../../", import.meta.url));
const names = appNames(definition);
const temp = () => mkdtempSync(join(tmpdir(), "release-history-"));

async function keys() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicJwk = await subtle.exportKey("jwk", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKey: await importPublicKey(publicJwk, subtle),
    env: { TRELLIS_PUBLIC_KEY: JSON.stringify(publicJwk), TRELLIS_SIGNING_KEY: JSON.stringify(await subtle.exportKey("jwk", pair.privateKey)) },
  };
}

/** What release.js does for one version, into its own folder: returns the manifest path. */
async function releaseInto(dir, { version, code, previousPath, key }) {
  const previous = previousPath ? await verifyManifest({ text: readFileSync(previousPath, "utf8"), publicKey: key.publicKey, subtle }) : null;
  const file = names.bundleFile(version);
  const body = releaseBody({ previous, version, file, sha256: await sha256Hex(new TextEncoder().encode(code), subtle), now: Date.now() });
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app", file), code);
  writeFileSync(join(dir, "app", "manifest.json"), await signManifest({ body, privateKey: key.privateKey, subtle }));
  return join(dir, "app", "manifest.json");
}

const readBody = async (path, key) => verifyManifest({ text: readFileSync(path, "utf8"), publicKey: key.publicKey, subtle });
const run = (args, env) => spawnSync(process.execPath, ["framework/build/release.js", ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } });

/** A signed manifest listing 1.0.0 and 1.1.0 with stable at 1.1.0, written to a temporary file. */
async function twoReleases(key) {
  const first = await releaseInto(temp(), { version: "1.0.0", code: "one", key });
  return releaseInto(temp(), { version: "1.1.0", code: "two", previousPath: first, key });
}

test("two releases in a row: the second manifest lists both bundles, the first one's hash unchanged", async () => {
  const key = await keys();
  const firstPath = await releaseInto(temp(), { version: "1.0.0", code: "one", key });
  const first = await readBody(firstPath, key);
  assert.deepEqual(Object.keys(first.bundles), ["1.0.0"]);

  const secondPath = await releaseInto(temp(), { version: "1.1.0", code: "two", previousPath: firstPath, key });
  const second = await readBody(secondPath, key);
  assert.deepEqual(Object.keys(second.bundles).sort(), ["1.0.0", "1.1.0"]);
  assert.deepEqual(second.bundles["1.0.0"], first.bundles["1.0.0"]);
  assert.equal(second.channels.stable, "1.1.0");
  assert.ok(second.serial > first.serial);
  // still format 1, and no field added to it
  assert.deepEqual(validateBody(second), second);
  assert.deepEqual(Object.keys(second).sort(), ["bundles", "channels", "format", "serial"]);
  // the release folder holds only the new bundle: earlier ones are already in the shared folder
  assert.deepEqual(readdirSync(join(secondPath, "..")).sort(), ["manifest.json", names.bundleFile("1.1.0")].sort());
});

test("the first release has no previous manifest and lists only its own bundle", () => {
  const body = releaseBody({ previous: null, version: "1.0.0", file: names.bundleFile("1.0.0"), sha256: "a".repeat(64), now: 5000 });
  assert.deepEqual(body, { format: 1, serial: 5, channels: { stable: "1.0.0" }, bundles: { "1.0.0": { file: names.bundleFile("1.0.0"), sha256: "a".repeat(64), minBootstrap: 1 } } });
});

test("a version already released with a different bundle is refused: bundles are write-once", () => {
  const previous = releaseBody({ previous: null, version: "1.0.0", file: names.bundleFile("1.0.0"), sha256: "a".repeat(64), now: 5000 });
  assert.throws(() => releaseBody({ previous, version: "1.0.0", file: names.bundleFile("1.0.0"), sha256: "b".repeat(64), now: 6000 }), /already released/);
});

test("the serial always rises, even when the clock has not moved past the previous one", () => {
  const previous = releaseBody({ previous: null, version: "1.0.0", file: names.bundleFile("1.0.0"), sha256: "a".repeat(64), now: 9_000_000 });
  assert.equal(rollbackBody({ previous, version: "1.0.0", now: 1000 }).serial, previous.serial + 1);
});

test("a previous manifest signed with another key stops the release before anything is built", async () => {
  const key = await keys();
  const foreign = await twoReleases(await keys());
  const out = temp();

  const result = run(["--previous", foreign, "--out", out], key.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /previous manifest/i);
  assert.deepEqual(readdirSync(out), []);

  const rollback = run(["--rollback", "1.0.0", "--previous", foreign, "--out", out], key.env);
  assert.notEqual(rollback.status, 0);
  assert.match(rollback.stderr, /previous manifest/i);
  assert.deepEqual(readdirSync(out), []);
});

test("--rollback signs a new manifest pointing stable at a listed version, and builds nothing", async () => {
  const key = await keys();
  const previousPath = await twoReleases(key);
  const previous = await readBody(previousPath, key);
  const out = temp();

  const result = run(["--rollback", "1.0.0", "--previous", previousPath, "--out", out], key.env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(out), [names.releaseFolder]);
  assert.deepEqual(readdirSync(join(out, names.releaseFolder)), ["app"]);
  assert.deepEqual(readdirSync(join(out, names.releaseFolder, "app")), ["manifest.json"]);

  const body = await readBody(join(out, names.releaseFolder, "app", "manifest.json"), key);
  assert.equal(body.channels.stable, "1.0.0");
  assert.ok(body.serial > previous.serial);
  assert.deepEqual(body.bundles, previous.bundles);
  assert.deepEqual(Object.keys(body).sort(), ["bundles", "channels", "format", "serial"]);
});

test("--rollback refuses a version the manifest does not list, and needs a previous manifest", async () => {
  const key = await keys();
  const previousPath = await twoReleases(key);
  const out = temp();

  const unlisted = run(["--rollback", "9.9.9", "--previous", previousPath, "--out", out], key.env);
  assert.notEqual(unlisted.status, 0);
  assert.match(unlisted.stderr, /9\.9\.9 is not listed/);

  const none = run(["--rollback", "1.0.0", "--out", out], key.env);
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /--previous/);
  assert.deepEqual(readdirSync(out), []);
});
