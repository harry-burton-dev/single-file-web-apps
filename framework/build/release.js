// Build a release: dist/release/<name>/, laid out like the shared folder
// (ADR-0005 section 2), ready to copy into it. Every name comes from
// app/app.config.ts through appNames:
//
//   <name>/<id>.html                 the bootstrap, holding the public key
//   <name>/<id>-admin.html           the admin page (no loader; holds no key)
//   <name>/app/<id>-<version>.js     the app bundle
//   <name>/app/manifest.json         signed: points the stable channel at this version
//
// History: `--previous <manifest.json>` (the last release's manifest) is
// verified with the public key and its bundles are listed again in the new
// manifest. The folder holds only the new bundle: earlier ones are already in
// the shared folder, because bundles are write-once. Without --previous this
// is the first release.
//
// Rollback: `--rollback <version> --previous <manifest.json>` builds nothing.
// It writes only <name>/app/manifest.json, signed with a new serial and
// pointing stable at a version the previous manifest already lists.
//
// `--out <dir>` writes the folder there instead of dist/release.
//
// Needs TRELLIS_PUBLIC_KEY and TRELLIS_SIGNING_KEY (JWK as JSON, from
// framework/build/keygen.js). The manifest's serial is the build time in seconds, so
// every release outranks the one before it (and is at least one above the
// previous manifest's). When GITHUB_OUTPUT is set, writes
// the release folder, zip file name and release title there for the workflow.
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { importPublicKey, sha256Hex, signManifest, verifyManifest } from "../runtime/loader/manifest.js";
import { appNames } from "../runtime/names.ts";
import { releaseBody, rollbackBody } from "./release-manifest.js";
import definition from "./app-definition.js";

const { subtle } = webcrypto;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VITE_CONFIG = join(ROOT, "framework", "build", "vite.config.js");
const DIST = join(ROOT, "dist");
const names = appNames(definition);
const { values: args } = parseArgs({ options: { previous: { type: "string" }, rollback: { type: "string" }, out: { type: "string" } } });
const OUT = join(args.out ?? join(DIST, "release"), names.releaseFolder);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

for (const name of ["TRELLIS_PUBLIC_KEY", "TRELLIS_SIGNING_KEY"]) {
  if (!process.env[name]) fail(`${name} is not set. Create a key pair with: npm run keygen`);
}
const publicKey = await importPublicKey(JSON.parse(process.env.TRELLIS_PUBLIC_KEY), subtle);
const privateKey = await subtle.importKey("jwk", JSON.parse(process.env.TRELLIS_SIGNING_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

/** Sign the body, check the two keys are a pair, and write <name>/app/manifest.json. */
async function writeManifest(body) {
  const manifest = await signManifest({ body, privateKey, subtle });
  // the two keys must be a pair, or every colleague's bootstrap would refuse this release
  await verifyManifest({ text: manifest, publicKey, subtle });
  mkdirSync(join(OUT, "app"), { recursive: true });
  writeFileSync(join(OUT, "app", "manifest.json"), manifest);
}

let previous = null;
if (args.previous) {
  try {
    previous = await verifyManifest({ text: readFileSync(args.previous, "utf8"), publicKey, subtle });
  } catch (err) {
    fail(`The previous manifest (${args.previous}) was refused: ${err.message} Nothing was released.`);
  }
  console.log(`previous manifest: serial ${previous.serial}, versions ${Object.keys(previous.bundles).join(", ")}`);
} else if (args.rollback) {
  fail("A rollback needs the current manifest: --previous <manifest.json>.");
} else {
  console.log("no previous manifest: this is the first release, so it lists only this version");
}

if (args.rollback) {
  let body;
  try {
    body = rollbackBody({ previous, version: args.rollback, now: Date.now() });
  } catch (err) {
    fail(err.message);
  }
  rmSync(OUT, { recursive: true, force: true });
  await writeManifest(body);
  console.log(`rollback to ${args.rollback} (serial ${body.serial}) written to ${join(OUT, "app", "manifest.json")}. Copy it into the shared folder's app/.`);
  process.exit(0);
}

const version = JSON.parse(readFileSync(join(ROOT, "app", "package.json"), "utf8")).version;
const bundleName = names.bundleFile(version);

for (const mode of ["bootstrap", "app", "admin"]) execFileSync("npx", ["vite", "build", "--config", VITE_CONFIG, "--mode", mode], { cwd: ROOT, stdio: "inherit" });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "app"), { recursive: true });
copyFileSync(join(DIST, "bootstrap.html"), join(OUT, names.bootstrapFile));
copyFileSync(join(DIST, "admin.html"), join(OUT, names.adminFile));
copyFileSync(join(DIST, "app", bundleName), join(OUT, "app", bundleName));

const bundle = readFileSync(join(OUT, "app", bundleName));
let body;
try {
  body = releaseBody({ previous, version, file: bundleName, sha256: await sha256Hex(bundle, subtle), now: Date.now() });
} catch (err) {
  fail(err.message);
}
await writeManifest(body);
console.log(`release ${version} (serial ${body.serial}) written to ${OUT}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `folder=${names.releaseFolder}\nzip=${names.releaseZip(version)}\ntitle=${names.title} ${version}\n`);
}
