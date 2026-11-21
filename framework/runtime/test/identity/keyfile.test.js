// The passphrase-wrapped key file (plan section 3.3): invites, key backups and
// passports share one format. Web Crypto only, runs in Node and the browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeededRandom } from "../../../engine/test/helpers/memfolder.js";
import { sealKeyFile, openKeyFile, KeyFileError, KDF_ITERATIONS } from "../../identity/keyfile.js";

const PASS = "correct horse battery";
const random = createSeededRandom(3);
const keys = [{ id: 1, raw: random.bytes(32) }, { id: 2, raw: random.bytes(32) }];
const base = { workspace: "k3x9q2m7a1b8c4d6", current: 2, keys };
const user = { id: "sam", name: "Sam Smith" };

const rejects = (promise, code, message) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof KeyFileError, `expected KeyFileError, got ${err}`);
    assert.equal(err.code, code);
    if (message) assert.equal(err.message, message);
    return true;
  });

const tamper = (text, change) => JSON.stringify(change(JSON.parse(text)));

for (const [kind, payload] of [["invite", { ...base, user }], ["key-backup", base], ["passport", { ...base, user }]]) {
  test(`${kind}: round trip keeps every key, the workspace and the user`, async () => {
    const text = await sealKeyFile({ kind, payload, passphrase: PASS, random });
    const outer = JSON.parse(text);
    assert.equal(outer.format, 1);
    assert.equal(outer.kind, kind);
    assert.deepEqual(outer.kdf.name, "PBKDF2");
    assert.equal(outer.kdf.iterations, KDF_ITERATIONS);
    assert.equal(atob(outer.kdf.salt).length, 16);
    assert.equal(atob(outer.iv).length, 12);
    assert.ok(!text.includes(PASS));
    const opened = await openKeyFile({ text, passphrase: PASS, kind });
    assert.deepEqual(opened, payload);
    assert.ok(opened.keys[0].raw instanceof Uint8Array);
  });
}

test("a wrong passphrase is refused with a message for people", async () => {
  const text = await sealKeyFile({ kind: "invite", payload: { ...base, user }, passphrase: PASS, random });
  await rejects(openKeyFile({ text, passphrase: "not the passphrase", kind: "invite" }), "wrong-passphrase", "That passphrase does not open this file.");
});

test("the passphrase is NFKC-normalised, so either spelling of the same text opens the file", async () => {
  const composed = "café au lait, s'il vous plaît";
  const decomposed = composed.normalize("NFD");
  assert.notEqual(composed, decomposed);
  const text = await sealKeyFile({ kind: "key-backup", payload: base, passphrase: composed, random });
  assert.deepEqual(await openKeyFile({ text, passphrase: decomposed, kind: "key-backup" }), base);
});

test("a file of another kind is refused before any decryption", async () => {
  const text = await sealKeyFile({ kind: "key-backup", payload: base, passphrase: PASS, random });
  await rejects(openKeyFile({ text, passphrase: PASS, kind: "invite" }), "wrong-kind", "This is a key backup file, not an invite file.");
});

test("a tampered kind is refused: the kind is bound into the ciphertext", async () => {
  const text = await sealKeyFile({ kind: "key-backup", payload: { ...base, user }, passphrase: PASS, random });
  const forged = tamper(text, (o) => ({ ...o, kind: "invite" }));
  await rejects(openKeyFile({ text: forged, passphrase: PASS, kind: "invite" }), "wrong-passphrase");
});

test("a low iteration count is refused, even with the right passphrase", async () => {
  const text = await sealKeyFile({ kind: "invite", payload: { ...base, user }, passphrase: PASS, random });
  const weak = tamper(text, (o) => ({ ...o, kdf: { ...o.kdf, iterations: 1000 } }));
  await rejects(openKeyFile({ text: weak, passphrase: PASS, kind: "invite" }), "bad-file", "This is not a valid invite file.");
});

test("an unknown format, other KDF settings and junk are refused as not valid", async () => {
  const text = await sealKeyFile({ kind: "passport", payload: { ...base, user }, passphrase: PASS, random });
  const bad = [
    tamper(text, (o) => ({ ...o, format: 2 })),
    tamper(text, (o) => ({ ...o, kdf: { ...o.kdf, hash: "SHA-1" } })),
    tamper(text, (o) => ({ ...o, kdf: { ...o.kdf, salt: "AAAA" } })),
    tamper(text, (o) => ({ ...o, iv: "AAAA" })),
    tamper(text, (o) => ({ ...o, data: "not base64!" })),
    "not json at all",
    "[]",
  ];
  for (const t of bad) await rejects(openKeyFile({ text: t, passphrase: PASS, kind: "passport" }), "bad-file", "This is not a valid passport file.");
});

test("a passphrase shorter than 12 characters is refused when sealing", async () => {
  await rejects(sealKeyFile({ kind: "invite", payload: { ...base, user }, passphrase: "short pass", random }), "weak-passphrase", "Use a passphrase of at least 12 characters.");
  // 12 characters counted after normalising, not bytes.
  await sealKeyFile({ kind: "invite", payload: { ...base, user }, passphrase: "é".repeat(12), random });
});

test("payloads that would not open later are refused when sealing", async () => {
  const bad = [
    { ...base, keys: [] },
    { ...base, current: 9 },
    { ...base, keys: [{ id: 0, raw: keys[0].raw }], current: 0 },
    { ...base, keys: [{ id: 1, raw: random.bytes(16) }], current: 1 },
    { ...base, keys: [keys[0], keys[0]], current: 1 },
    { ...base, workspace: "" },
    { ...base, workspace: "UPPER-case-id!!!" },
    { ...base, user: { id: "Not An Id", name: "x" } },
  ];
  for (const payload of bad) await rejects(sealKeyFile({ kind: "key-backup", payload, passphrase: PASS, random }), "bad-file");
  await rejects(sealKeyFile({ kind: "invite", payload: base, passphrase: PASS, random }), "bad-file"); // an invite needs a user
  await rejects(sealKeyFile({ kind: "passport", payload: base, passphrase: PASS, random }), "bad-file"); // so does a passport
  await rejects(sealKeyFile({ kind: "other", payload: base, passphrase: PASS, random }), "bad-file");
});
