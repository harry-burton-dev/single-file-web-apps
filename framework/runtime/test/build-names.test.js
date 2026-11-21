// A real build takes every name from the definition it is given (spec S1, gate G3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webcrypto } from "node:crypto";
import { build } from "vite";
import { appConfig } from "../../build/vite.config.js";
import repoDefinition from "../../build/app-definition.js";
import { appNames } from "../names.ts";
import { BUNDLE_FILE_RE } from "../loader/manifest.js";

test("the manifest accepts the bundle file name the build gives", () => {
  for (const id of ["acme-notes", "farm2", repoDefinition.id]) assert.match(appNames({ id, name: "X" }).bundleFile("1.2.3"), BUNDLE_FILE_RE);
  for (const file of ["../acme-1.0.0.js", "app/acme-1.0.0.js", "Acme-1.0.0.js", "acme.js"]) assert.doesNotMatch(file, BUNDLE_FILE_RE);
});

test("a build through the Vite factory uses the given definition's names", async () => {
  const definition = { id: "acme-notes", name: "Acme Notes", tables: {} };
  const version = "9.8.7";
  const outDir = mkdtempSync(join(tmpdir(), "names-build-"));
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  process.env.TRELLIS_PUBLIC_KEY = JSON.stringify(await webcrypto.subtle.exportKey("jwk", pair.publicKey));
  try {
    for (const mode of ["bootstrap", "app"]) {
      await build({ configFile: false, logLevel: "silent", ...appConfig({ definition, version, mode, outDir }) });
    }
    const bootstrap = readFileSync(join(outDir, "bootstrap.html"), "utf8");
    assert.match(bootstrap, /<title>Acme Notes<\/title>/);
    assert.ok(bootstrap.includes("acme-notes"), "the bootstrap holds the app id");
    assert.deepEqual(readdirSync(join(outDir, "app")), [`acme-notes-${version}.js`]);
    const bundle = readFileSync(join(outDir, "app", `acme-notes-${version}.js`), "utf8");
    for (const [name, text] of [["bootstrap", bootstrap], ["bundle", bundle]]) {
      assert.ok(!text.includes(repoDefinition.id), `the ${name} does not contain ${repoDefinition.id}`);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
