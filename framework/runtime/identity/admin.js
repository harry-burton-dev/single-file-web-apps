// Admin operations with no screen (plan 3.9): make and rotate the workspace
// keyring, mint invites, export and reopen the key backup, and write users
// records. No DOM, so the G6 test runs it in Node. The admin page (OUT-10)
// holds the keyring in memory only and stores no key (decision D7).
import { sealKeyFile, openKeyFile } from "./keyfile.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const USER_ID = /^[a-z][a-z0-9]{1,15}$/;
const MAX_KEY_ID = 255;
const ROLES = new Set(["admin", "member"]);
const STATUSES = new Set(["active", "inactive"]);

export const USERS_TABLE = "users";
export const USERS_SCHEMA = { version: 1, fields: { name: "latest", role: "latest", status: "latest" } };

/** 16 lower-case letters and digits. Rejection sampling keeps every character equally likely. */
function workspaceId(random) {
  let id = "";
  while (id.length < 16) {
    for (const b of random.bytes(16)) if (b < 252 && id.length < 16) id += ALPHABET[b % 36];
  }
  return id;
}

/** A keyring for a new workspace: a random id and key 1. */
export function newKeyring({ random }) {
  return { workspace: workspaceId(random), current: 1, keys: [{ id: 1, raw: random.bytes(32) }] };
}

/** A new keyring with one more key, now current. Old keys stay so old data stays readable. */
export function rotateKeyring(keyring, { random }) {
  const next = Math.max(...keyring.keys.map((k) => k.id)) + 1;
  if (next > MAX_KEY_ID) throw new Error(`This workspace has used all ${MAX_KEY_ID} key ids and cannot rotate again.`);
  return {
    workspace: keyring.workspace,
    current: next,
    keys: [...keyring.keys.map((k) => ({ id: k.id, raw: Uint8Array.from(k.raw) })), { id: next, raw: random.bytes(32) }],
  };
}

/**
 * A user id from a display name: its letters and digits, accents dropped,
 * lower case, starting with a letter, at most 16 characters. If that is
 * taken (or too short), a digit suffix is added: samsmith2, samsmith3.
 */
export function userIdFor(name, takenIds) {
  const taken = new Set(takenIds);
  const base = String(name ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^[0-9]+/, "") || "user";
  const free = (id) => USER_ID.test(id) && !taken.has(id);
  if (free(base.slice(0, 16))) return base.slice(0, 16);
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const id = base.slice(0, 16 - suffix.length) + suffix;
    if (free(id)) return id;
  }
}

/** The text of an invite file for one user, holding every key (decision D9). */
export function mintInvite({ keyring, user, passphrase, random }) {
  const { workspace, current, keys } = keyring;
  return sealKeyFile({ kind: "invite", payload: { workspace, current, keys, user: { id: user?.id, name: user?.name } }, passphrase, random });
}

/** The text of a key backup file. It holds the keyring and no user. */
export function exportBackup({ keyring, passphrase, random }) {
  const { workspace, current, keys } = keyring;
  return sealKeyFile({ kind: "key-backup", payload: { workspace, current, keys }, passphrase, random });
}

/** The keyring in a key backup file. Throws KeyFileError. */
export function openBackup({ text, passphrase }) {
  return openKeyFile({ text, passphrase, kind: "key-backup" });
}

/**
 * The keyring as the engine takes it: non-extractable CryptoKeys by key id,
 * writing with the current key. The raw bytes are left in the keyring, because
 * the admin goes on using it to mint invites and backups.
 */
export async function engineKeys(keyring) {
  const keys = new Map();
  for (const { id, raw } of keyring.keys) keys.set(id, await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  return { key: keys.get(keyring.current), keyId: keyring.current, keys };
}

/** Writes one users record. Removing a user is status "inactive"; it does not rotate the key. */
export function putUser(table, { id, name, role, status }) {
  if (typeof id !== "string" || !USER_ID.test(id)) throw new TypeError(`user id ${JSON.stringify(id)} must be 2 to 16 lower-case letters and digits, starting with a letter`);
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("user name must be a non-empty string");
  if (!ROLES.has(role)) throw new TypeError(`user role must be "admin" or "member", not ${JSON.stringify(role)}`);
  if (!STATUSES.has(status)) throw new TypeError(`user status must be "active" or "inactive", not ${JSON.stringify(status)}`);
  table.put(id, { name, role, status });
}
