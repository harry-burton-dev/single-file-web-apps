// The loader runs only what the admin signed (ADR-0005 sections 4 and 5).
// Every way a manifest or bundle can be wrong is refused with its own code,
// and a refusal never disturbs what is already cached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createMemFolder } from "../../engine/test/helpers/memfolder.js";
import { importPublicKey, sha256Hex, signManifest, verifyManifest } from "../loader/manifest.js";
import { cachedBundle, checkForUpdate, readState } from "../loader/loader.js";
import { rollbackBody } from "../../build/release-manifest.js";

const { subtle } = webcrypto;
const text = (s) => new TextEncoder().encode(s);

async function keyPair() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { privateKey: pair.privateKey, publicKey: await importPublicKey(await subtle.exportKey("jwk", pair.publicKey), subtle) };
}

function memCache() {
  const map = new Map();
  return {
    map,
    get: async (k) => map.get(k),
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
  };
}

/** A folder, a cache and an admin key, plus publish(): what the admin app does on release. */
async function setup() {
  const admin = await keyPair();
  const folder = createMemFolder();
  const cache = memCache();
  const bundles = {};
  let serial = 0;
  const w = {
    folder, cache, admin,
    async writeManifest(body, key = admin.privateKey) {
      folder.drop("app/manifest.json", text(await signManifest({ body, privateKey: key, subtle })));
    },
    /** Put a bundle in the folder and point the stable channel at it. Returns the manifest body. */
    async publish(version, code, { minBootstrap = 1, dropBundle = true } = {}) {
      const bytes = text(code);
      if (dropBundle) folder.drop(`app/app-${version}.js`, bytes);
      bundles[version] = { file: `app-${version}.js`, sha256: await sha256Hex(bytes, subtle), minBootstrap };
      serial += 1;
      const body = { format: 1, serial, channels: { stable: version }, bundles: { ...bundles } };
      await w.writeManifest(body);
      return body;
    },
    check: (extra = {}) => checkForUpdate({ root: folder.root, cache, publicKey: admin.publicKey, subtle, bootstrapVersion: 1, ...extra }),
    current: async () => {
      const b = await cachedBundle(cache);
      return b && { version: b.version, code: new TextDecoder().decode(b.bytes) };
    },
  };
  return w;
}

/** A world that already runs 1.0.0, so a refusal can be shown to leave it alone. */
async function running() {
  const w = await setup();
  await w.publish("1.0.0", "one");
  assert.deepEqual(await w.check(), { status: "updated", version: "1.0.0" });
  return w;
}

async function refused(w, code, extra) {
  const result = await w.check(extra);
  assert.equal(result.status, "rejected", JSON.stringify(result));
  assert.equal(result.code, code);
  assert.ok(result.message.length > 10);
  assert.deepEqual(await w.current(), { version: "1.0.0", code: "one" }, "the cached bundle is untouched");
}

test("first run: a signed manifest and matching bundle are cached and become current", async () => {
  const w = await setup();
  assert.equal(await cachedBundle(w.cache), null);
  await w.publish("1.0.0", "one");

  assert.deepEqual(await w.check(), { status: "updated", version: "1.0.0" });
  assert.deepEqual(await w.current(), { version: "1.0.0", code: "one" });
  assert.deepEqual(await w.check(), { status: "current", version: "1.0.0" });
});

test("an update keeps the previous bundle, and only two are kept", async () => {
  const w = await running();
  await w.publish("1.1.0", "two");
  await w.check();
  await w.publish("1.2.0", "three");
  assert.deepEqual(await w.check(), { status: "updated", version: "1.2.0" });

  assert.deepEqual(await w.current(), { version: "1.2.0", code: "three" });
  assert.equal((await cachedBundle(w.cache, { previous: true })).version, "1.1.0");
  assert.deepEqual([...w.cache.map.keys()].sort(), ["loader/bundle/1.1.0", "loader/bundle/1.2.0", "loader/state"]);
});

test("a deliberate rollback is a newer manifest naming an older bundle, served from the cache", async () => {
  const w = await running();
  const body = await w.publish("1.1.0", "two");
  await w.check();
  w.folder.remove("app/app-1.0.0.js"); // not needed again: it is cached
  await w.writeManifest({ ...body, serial: body.serial + 1, channels: { stable: "1.0.0" } });

  assert.deepEqual(await w.check(), { status: "updated", version: "1.0.0" });
  assert.equal((await cachedBundle(w.cache, { previous: true })).version, "1.1.0");
});

test("a rollback manifest from npm run release -- --rollback makes the loader run N again; old manifests stay refused", async () => {
  const w = await running();
  const manifestN = w.folder.read("app/manifest.json");
  const body = await w.publish("1.1.0", "two");
  assert.deepEqual(await w.check(), { status: "updated", version: "1.1.0" });
  const manifestN1 = w.folder.read("app/manifest.json");

  await w.writeManifest(rollbackBody({ previous: body, version: "1.0.0", now: 0 }));
  assert.deepEqual(await w.check(), { status: "updated", version: "1.0.0" });
  assert.deepEqual(await w.current(), { version: "1.0.0", code: "one" });

  for (const old of [manifestN, manifestN1]) {
    w.folder.drop("app/manifest.json", old);
    assert.equal((await w.check()).code, "serial-replayed");
    assert.deepEqual(await w.current(), { version: "1.0.0", code: "one" });
  }
});

test("refused: no manifest in the folder", async () => {
  const w = await running();
  w.folder.remove("app/manifest.json");
  await refused(w, "manifest-missing");
});

test("refused: the folder cannot be read", async () => {
  const w = await running();
  const root = { getDirectoryHandle: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } };
  await refused(w, "folder-unreadable", { root });
});

test("refused: a half-synced manifest", async () => {
  const w = await running();
  await w.publish("1.1.0", "two");
  const whole = w.folder.read("app/manifest.json");
  w.folder.drop("app/manifest.json", whole.slice(0, whole.length - 20));
  await refused(w, "manifest-unreadable");
});

test("refused: a manifest signed with another key", async () => {
  const w = await running();
  const body = await w.publish("1.1.0", "two");
  await w.writeManifest(body, (await keyPair()).privateKey);
  await refused(w, "signature-invalid");
});

test("refused: a body changed after signing", async () => {
  const w = await running();
  await w.publish("1.1.0", "two");
  const file = JSON.parse(new TextDecoder().decode(w.folder.read("app/manifest.json")));
  w.folder.drop("app/manifest.json", text(JSON.stringify({ ...file, body: file.body.replace('"serial":2', '"serial":9') })));
  await refused(w, "signature-invalid");
});

test("refused: a signature that is not base64", async () => {
  const w = await running();
  await w.publish("1.1.0", "two");
  const file = JSON.parse(new TextDecoder().decode(w.folder.read("app/manifest.json")));
  w.folder.drop("app/manifest.json", text(JSON.stringify({ ...file, signature: "***" })));
  await refused(w, "signature-invalid");
});

test("refused: a correctly signed body of the wrong shape", async () => {
  const w = await running();
  const sign = async (bodyText) => {
    const signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, w.admin.privateKey, text(bodyText));
    w.folder.drop("app/manifest.json", text(JSON.stringify({ body: bodyText, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) })));
  };
  const good = { format: 1, serial: 5, channels: { stable: "2.0.0" }, bundles: { "2.0.0": { file: "app-2.0.0.js", sha256: "0".repeat(64), minBootstrap: 1 } } };
  const wrong = [
    "not json",
    JSON.stringify({ ...good, format: 2 }),
    JSON.stringify({ ...good, serial: 1.5 }),
    JSON.stringify({ ...good, channels: null }),
    JSON.stringify({ ...good, bundles: { "2.0.0": { ...good.bundles["2.0.0"], file: "../data/evil.js" } } }),
    JSON.stringify({ ...good, bundles: { "2.0.0": { ...good.bundles["2.0.0"], sha256: "abc" } } }),
    JSON.stringify({ ...good, bundles: { "2.0.0": { ...good.bundles["2.0.0"], minBootstrap: 0 } } }),
    JSON.stringify({ ...good, plugins: {} }),
  ];
  for (const bodyText of wrong) {
    await sign(bodyText);
    await refused(w, "manifest-invalid");
  }
});

test("refused: an older signed manifest replayed to force a downgrade", async () => {
  const w = await running();
  const old = w.folder.read("app/manifest.json");
  await w.publish("1.1.0", "two");
  await w.check();
  w.folder.drop("app/manifest.json", old);

  const result = await w.check();
  assert.equal(result.code, "serial-replayed");
  assert.equal((await w.current()).version, "1.1.0");
});

test("a manifest whose bundle has not arrived still rules out older manifests", async () => {
  const w = await running();
  const old = w.folder.read("app/manifest.json");
  await w.publish("1.1.0", "two", { dropBundle: false });
  await refused(w, "bundle-missing");
  w.folder.drop("app/manifest.json", old);
  await refused(w, "serial-replayed");
});

test("refused: the channel is not in the manifest", async () => {
  const w = await running();
  await w.publish("1.1.0", "two");
  await refused(w, "channel-unknown", { channel: "beta" });
});

test("refused: the channel names a version the manifest does not describe", async () => {
  const w = await running();
  const body = await w.publish("1.1.0", "two");
  await w.writeManifest({ ...body, serial: body.serial + 1, channels: { stable: "9.9.9" } });
  await refused(w, "bundle-unlisted");
});

test("refused: the bundle needs a newer bootstrap", async () => {
  const w = await running();
  await w.publish("2.0.0", "two", { minBootstrap: 2 });
  await refused(w, "bootstrap-too-old");
  assert.deepEqual(await w.check({ bootstrapVersion: 2 }), { status: "updated", version: "2.0.0" });
});

test("refused: a half-synced or replaced bundle, accepted once the real one arrives", async () => {
  const w = await running();
  await w.publish("1.1.0", "the real bundle");
  w.folder.drop("app/app-1.1.0.js", text("the real bun"));
  await refused(w, "bundle-hash-mismatch");

  w.folder.drop("app/app-1.1.0.js", text("the real bundle"));
  assert.deepEqual(await w.check(), { status: "updated", version: "1.1.0" });
});

test("refused: the cache cannot be written", async () => {
  const w = await running();
  await w.publish("1.1.0", "two");
  const before = await readState(w.cache);
  const cache = { ...w.cache, set: async () => { throw new Error("quota"); } };

  const result = await w.check({ cache });
  assert.equal(result.status, "rejected");
  assert.equal(result.code, "unexpected");
  assert.deepEqual(await readState(w.cache), before);
});

test("verifyManifest returns the signed body", async () => {
  const w = await setup();
  const body = await w.publish("1.0.0", "one");
  const got = await verifyManifest({ text: new TextDecoder().decode(w.folder.read("app/manifest.json")), publicKey: w.admin.publicKey, subtle });
  assert.deepEqual(got, body);
});
