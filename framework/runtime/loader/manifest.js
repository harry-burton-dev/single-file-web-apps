// The signed release manifest (ADR-0005 sections 3 and 4).
//
// app/manifest.json is one JSON file: { "body": "<JSON text>", "signature":
// "<base64>" }. The signature (ECDSA P-256, SHA-256) is over the exact bytes
// of the body text, so body and signature can never be out of step and no
// canonical JSON form is needed.
//
// Plain JavaScript with no imports: the bootstrap, the admin app and the
// release scripts all use it, in the browser and in Node.

export const MANIFEST_FORMAT = 1;
/** Bundles are write-once files named <app id>-<version>.js, directly in app/. */
export const BUNDLE_FILE_RE = /^[a-z0-9]+(-[a-z0-9]+)*-[0-9A-Za-z][0-9A-Za-z.-]*\.js$/;

const ECDSA = { name: "ECDSA", hash: "SHA-256" };
const CURVE = { name: "ECDSA", namedCurve: "P-256" };
const SHA256_RE = /^[0-9a-f]{64}$/;

/** A refusal with a stable code the bootstrap can show and tests can check. */
export class LoaderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LoaderError";
    this.code = code;
  }
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export const importPublicKey = (jwk, subtle) => subtle.importKey("jwk", jwk, CURVE, false, ["verify"]);

export async function sha256Hex(bytes, subtle) {
  return [...new Uint8Array(await subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 1;

/** Throws LoaderError("manifest-invalid") unless the body has the shape of section 3. */
export function validateBody(body) {
  const bad = (what) => new LoaderError("manifest-invalid", `The release manifest is not valid: ${what}.`);
  if (!isObject(body)) throw bad("it is not an object");
  if (body.format !== MANIFEST_FORMAT) throw bad(`format ${body.format} is not supported by this loader`);
  if (!isCount(body.serial)) throw bad("serial must be a whole number from 1");
  if (!isObject(body.channels) || !Object.values(body.channels).every((v) => typeof v === "string")) throw bad("channels must map names to versions");
  if (!isObject(body.bundles)) throw bad("bundles is missing");
  for (const [version, b] of Object.entries(body.bundles)) {
    if (!isObject(b) || !BUNDLE_FILE_RE.test(b.file ?? "")) throw bad(`bundle ${version} has no usable file name`);
    if (!SHA256_RE.test(b.sha256 ?? "")) throw bad(`bundle ${version} has no SHA-256 hash`);
    if (!isCount(b.minBootstrap)) throw bad(`bundle ${version} does not state the bootstrap it needs`);
  }
  if (body.plugins !== undefined && !Array.isArray(body.plugins)) throw bad("plugins must be a list");
  return body;
}

/** The manifest file's text -> its verified, validated body. Throws LoaderError. */
export async function verifyManifest({ text, publicKey, subtle }) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    file = null;
  }
  if (!isObject(file) || typeof file.body !== "string" || typeof file.signature !== "string") {
    throw new LoaderError("manifest-unreadable", "The release manifest could not be read. It may still be syncing.");
  }
  let ok = false;
  try {
    ok = await subtle.verify(ECDSA, publicKey, fromBase64(file.signature), new TextEncoder().encode(file.body));
  } catch {
    ok = false;
  }
  if (!ok) throw new LoaderError("signature-invalid", "The release manifest is not signed by this app's admin. It was ignored.");
  let body;
  try {
    body = JSON.parse(file.body);
  } catch {
    body = null;
  }
  return validateBody(body);
}

/** A body object -> the manifest file's text. Used by the admin app and the release scripts. */
export async function signManifest({ body, privateKey, subtle }) {
  const text = JSON.stringify(validateBody(body));
  const signature = await subtle.sign(ECDSA, privateKey, new TextEncoder().encode(text));
  return JSON.stringify({ body: text, signature: toBase64(signature) });
}
