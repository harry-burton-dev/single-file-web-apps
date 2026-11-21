// Build a release: dist/release/Workbench/, laid out like the shared folder
// (ADR-0005 section 2), ready to copy into it:
//
//   Workbench/workbench.html         the bootstrap, holding the public key
//   Workbench/app/app-<version>.js   the app bundle
//   Workbench/app/manifest.json      signed: points the stable channel at this version
//
// Needs WORKBENCH_PUBLIC_KEY and WORKBENCH_SIGNING_KEY (JWK as JSON, from
// framework/build/keygen.js). The manifest's serial is the build time in seconds, so
// every release outranks the one before it.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { importPublicKey, sha256Hex, signManifest, verifyManifest } from "../runtime/loader/manifest.js";

const { subtle } = webcrypto;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(ROOT, "dist");
const OUT = join(DIST, "release", "Workbench");

for (const name of ["WORKBENCH_PUBLIC_KEY", "WORKBENCH_SIGNING_KEY"]) {
  if (!process.env[name]) {
    console.error(`${name} is not set. Create a key pair with: npm run keygen`);
    process.exit(1);
  }
}
const version = JSON.parse(readFileSync(join(ROOT, "app", "package.json"), "utf8")).version;
const bundleName = `app-${version}.js`;

for (const mode of ["bootstrap", "app"]) execFileSync("npx", ["vite", "build", "--config", "framework/build/vite.config.ts", "--mode", mode], { cwd: ROOT, stdio: "inherit" });

rmSync(join(DIST, "release"), { recursive: true, force: true });
mkdirSync(join(OUT, "app"), { recursive: true });
copyFileSync(join(DIST, "workbench.html"), join(OUT, "workbench.html"));
copyFileSync(join(DIST, "app", bundleName), join(OUT, "app", bundleName));

const bundle = readFileSync(join(OUT, "app", bundleName));
const body = {
  format: 1,
  serial: Math.floor(Date.now() / 1000),
  channels: { stable: version },
  bundles: { [version]: { file: bundleName, sha256: await sha256Hex(bundle, subtle), minBootstrap: 1 } },
};
const privateKey = await subtle.importKey("jwk", JSON.parse(process.env.WORKBENCH_SIGNING_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
const manifest = await signManifest({ body, privateKey, subtle });
// the two keys must be a pair, or every colleague's bootstrap would refuse this release
await verifyManifest({ text: manifest, publicKey: await importPublicKey(JSON.parse(process.env.WORKBENCH_PUBLIC_KEY), subtle), subtle });
writeFileSync(join(OUT, "app", "manifest.json"), manifest);
console.log(`release ${version} (serial ${body.serial}) written to ${OUT}`);
