// Build a release: dist/release/<name>/, laid out like the shared folder
// (ADR-0005 section 2), ready to copy into it. Every name comes from
// app/app.config.ts through appNames:
//
//   <name>/<id>.html                 the bootstrap, holding the public key
//   <name>/app/<id>-<version>.js     the app bundle
//   <name>/app/manifest.json         signed: points the stable channel at this version
//
// Needs TRELLIS_PUBLIC_KEY and TRELLIS_SIGNING_KEY (JWK as JSON, from
// framework/build/keygen.js). The manifest's serial is the build time in seconds, so
// every release outranks the one before it. When GITHUB_OUTPUT is set, writes
// the release folder, zip file name and release title there for the workflow.
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { importPublicKey, sha256Hex, signManifest, verifyManifest } from "../runtime/loader/manifest.js";
import { appNames } from "../runtime/names.ts";
import definition from "./app-definition.js";

const { subtle } = webcrypto;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VITE_CONFIG = join(ROOT, "framework", "build", "vite.config.js");
const DIST = join(ROOT, "dist");
const names = appNames(definition);
const OUT = join(DIST, "release", names.releaseFolder);

for (const name of ["TRELLIS_PUBLIC_KEY", "TRELLIS_SIGNING_KEY"]) {
  if (!process.env[name]) {
    console.error(`${name} is not set. Create a key pair with: npm run keygen`);
    process.exit(1);
  }
}
const version = JSON.parse(readFileSync(join(ROOT, "app", "package.json"), "utf8")).version;
const bundleName = names.bundleFile(version);

for (const mode of ["bootstrap", "app"]) execFileSync("npx", ["vite", "build", "--config", VITE_CONFIG, "--mode", mode], { cwd: ROOT, stdio: "inherit" });

rmSync(join(DIST, "release"), { recursive: true, force: true });
mkdirSync(join(OUT, "app"), { recursive: true });
copyFileSync(join(DIST, "bootstrap.html"), join(OUT, names.bootstrapFile));
copyFileSync(join(DIST, "app", bundleName), join(OUT, "app", bundleName));

const bundle = readFileSync(join(OUT, "app", bundleName));
const body = {
  format: 1,
  serial: Math.floor(Date.now() / 1000),
  channels: { stable: version },
  bundles: { [version]: { file: bundleName, sha256: await sha256Hex(bundle, subtle), minBootstrap: 1 } },
};
const privateKey = await subtle.importKey("jwk", JSON.parse(process.env.TRELLIS_SIGNING_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
const manifest = await signManifest({ body, privateKey, subtle });
// the two keys must be a pair, or every colleague's bootstrap would refuse this release
await verifyManifest({ text: manifest, publicKey: await importPublicKey(JSON.parse(process.env.TRELLIS_PUBLIC_KEY), subtle), subtle });
writeFileSync(join(OUT, "app", "manifest.json"), manifest);
console.log(`release ${version} (serial ${body.serial}) written to ${OUT}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `folder=${names.releaseFolder}\nzip=${names.releaseZip(version)}\ntitle=${names.title} ${version}\n`);
}
