// The key file (plan 3.3): invites, key backups and passports. A keyring
// sealed under a passphrase with PBKDF2 and AES-GCM. Web Crypto only; no DOM,
// so it runs in Node and the browser.
import { toBase64, fromBase64 } from "./base64.js";

export const KDF_ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 12;
const KINDS = { invite: "invite file", "key-backup": "key backup file", passport: "passport file" };
const WITH_USER = new Set(["invite", "passport"]);
const WORKSPACE_ID = /^[a-z0-9]{16}$/;
const USER_ID = /^[a-z][a-z0-9]{1,15}$/;
const encoder = new TextEncoder();

const article = (kind) => (kind === "invite" ? "an" : "a");
const MESSAGES = {
  "wrong-passphrase": () => "That passphrase does not open this file.",
  "bad-file": (kind) => `This is not a valid ${KINDS[kind] ?? "key file"}.`,
  "wrong-kind": (kind, found) => `This is ${article(found)} ${KINDS[found]}, not ${article(kind)} ${KINDS[kind]}.`,
  "weak-passphrase": () => `Use a passphrase of at least ${MIN_PASSPHRASE} characters.`,
};

export class KeyFileError extends Error {
  constructor(code, kind, found) {
    super(MESSAGES[code](kind, found));
    this.name = "KeyFileError";
    this.code = code;
  }
}

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** True when payload is a keyring (plan 3.2), plus a user for invites and passports. */
function validPayload(kind, p) {
  if (!isRecord(p) || typeof p.workspace !== "string" || !WORKSPACE_ID.test(p.workspace)) return false;
  if (!Array.isArray(p.keys) || p.keys.length === 0) return false;
  const ids = new Set();
  for (const k of p.keys) {
    if (!isRecord(k) || !Number.isInteger(k.id) || k.id < 1 || k.id > 255 || ids.has(k.id)) return false;
    if (!(k.raw instanceof Uint8Array) || k.raw.length !== 32) return false;
    ids.add(k.id);
  }
  if (!ids.has(p.current)) return false;
  const needsUser = WITH_USER.has(kind);
  if (needsUser || p.user !== undefined) {
    if (!isRecord(p.user) || typeof p.user.id !== "string" || !USER_ID.test(p.user.id)) return false;
    if (typeof p.user.name !== "string" || p.user.name.trim() === "") return false;
  }
  return true;
}

const normalise = (passphrase) => passphrase.normalize("NFKC");
const aad = (kind) => encoder.encode(`keyfile-1:${kind}`);

async function wrappingKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", encoder.encode(normalise(passphrase)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seal a keyring as a key file. Returns the file's text. */
export async function sealKeyFile({ kind, payload, passphrase, random }) {
  if (!KINDS[kind] || !validPayload(kind, payload)) throw new KeyFileError("bad-file", kind);
  if (typeof passphrase !== "string" || [...normalise(passphrase)].length < MIN_PASSPHRASE) throw new KeyFileError("weak-passphrase", kind);
  const salt = random.bytes(16);
  const iv = random.bytes(12);
  const plain = { ...payload, keys: payload.keys.map((k) => ({ id: k.id, raw: toBase64(k.raw) })) };
  const key = await wrappingKey(passphrase, salt, KDF_ITERATIONS);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(kind) }, key, encoder.encode(JSON.stringify(plain)));
  return JSON.stringify(
    { format: 1, kind, kdf: { name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS, salt: toBase64(salt) }, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) },
    null,
    2,
  );
}

function parseOuter(text, kind) {
  let outer;
  try {
    outer = JSON.parse(text);
  } catch {
    throw new KeyFileError("bad-file", kind);
  }
  if (!isRecord(outer) || outer.format !== 1 || !isRecord(outer.kdf)) throw new KeyFileError("bad-file", kind);
  if (outer.kind !== kind) {
    if (KINDS[outer.kind]) throw new KeyFileError("wrong-kind", kind, outer.kind);
    throw new KeyFileError("bad-file", kind);
  }
  const { name, hash, iterations } = outer.kdf;
  const salt = fromBase64(outer.kdf.salt);
  const iv = fromBase64(outer.iv);
  const data = fromBase64(outer.data);
  if (name !== "PBKDF2" || hash !== "SHA-256" || !Number.isInteger(iterations) || iterations < KDF_ITERATIONS) throw new KeyFileError("bad-file", kind);
  if (salt?.length !== 16 || iv?.length !== 12 || !data || data.length < 16) throw new KeyFileError("bad-file", kind);
  return { iterations, salt, iv, data };
}

/** Open a key file of the expected kind. Returns its payload, raw keys as Uint8Array. */
export async function openKeyFile({ text, passphrase, kind }) {
  const { iterations, salt, iv, data } = parseOuter(text, kind);
  const key = await wrappingKey(String(passphrase ?? ""), salt, iterations);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(kind) }, key, data);
  } catch {
    // GCM cannot tell a wrong passphrase from a tampered file; the first is far more likely.
    throw new KeyFileError("wrong-passphrase", kind);
  }
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(plain));
    payload.keys = payload.keys.map((k) => ({ id: k.id, raw: fromBase64(k.raw) }));
  } catch {
    throw new KeyFileError("bad-file", kind);
  }
  if (!validPayload(kind, payload)) throw new KeyFileError("bad-file", kind);
  return payload;
}
