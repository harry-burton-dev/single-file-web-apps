// The .ywb envelope (ADR-0001 section 5).
//
//   bytes 0-3   magic "EAW1"
//   byte  4     key id
//   bytes 5-16  random IV (new for every write, supplied by the caller)
//   bytes 17-   AES-256-GCM ciphertext; bytes 0-16 are authenticated data
//
// Plaintext: u32be metadata length, metadata JSON, then each update as
// u32be length + bytes. Status files use the same envelope with no updates.
import { MAGIC, HEADER_BYTES, IV_BYTES, GCM_TAG_BYTES } from "./constants.js";

export class EnvelopeError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "EnvelopeError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new EnvelopeError("expected bytes");
}

function u32(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Length-prefix a list of updates (also used for the local store's log). */
export function frameUpdates(updates) {
  return concat(updates.flatMap((u) => [u32(u.length), u]));
}

/** Inverse of frameUpdates; throws EnvelopeError on any overrun. */
export function parseFrames(bytes, offset = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let at = offset;
  while (at < bytes.length) {
    if (at + 4 > bytes.length) throw new EnvelopeError("truncated update length");
    const len = view.getUint32(at, false);
    at += 4;
    if (at + len > bytes.length) throw new EnvelopeError("truncated update");
    out.push(bytes.slice(at, at + len));
    at += len;
  }
  return out;
}

export async function seal({ key, keyId, iv, meta, updates = [] }) {
  if (!Number.isInteger(keyId) || keyId < 0 || keyId > 255) throw new EnvelopeError("keyId must be 0-255");
  if (!(iv instanceof Uint8Array) || iv.length !== IV_BYTES) throw new EnvelopeError("iv must be 12 bytes");
  const header = concat([MAGIC, Uint8Array.of(keyId), iv]);
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const plain = concat([u32(metaBytes.length), metaBytes, frameUpdates(updates)]);
  const cipher = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: header },
    key,
    plain,
  );
  return concat([header, new Uint8Array(cipher)]);
}

function lookupKey(keys, keyId) {
  const key = keys instanceof Map ? keys.get(keyId) : keys?.[keyId];
  if (!key) throw new EnvelopeError(`no key for key id ${keyId}`);
  return key;
}

function parseBody(plain) {
  if (plain.length < 4) throw new EnvelopeError("body too short");
  const metaLen = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0, false);
  if (4 + metaLen > plain.length) throw new EnvelopeError("metadata overruns body");
  let meta;
  try {
    meta = JSON.parse(decoder.decode(plain.subarray(4, 4 + metaLen)));
  } catch (err) {
    throw new EnvelopeError("bad metadata", err);
  }
  return { meta, updates: parseFrames(plain, 4 + metaLen) };
}

/** Decrypt and parse. Throws EnvelopeError for anything unreadable. */
export async function open({ keys, bytes }) {
  const data = toBytes(bytes);
  if (data.length < HEADER_BYTES + GCM_TAG_BYTES) throw new EnvelopeError("file too short");
  for (let i = 0; i < MAGIC.length; i++) {
    if (data[i] !== MAGIC[i]) throw new EnvelopeError("bad magic");
  }
  const key = lookupKey(keys, data[4]);
  let plain;
  try {
    const buf = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: data.subarray(5, HEADER_BYTES), additionalData: data.subarray(0, HEADER_BYTES) },
      key,
      data.subarray(HEADER_BYTES),
    );
    plain = new Uint8Array(buf);
  } catch (err) {
    throw new EnvelopeError("decryption failed", err);
  }
  return parseBody(plain);
}
