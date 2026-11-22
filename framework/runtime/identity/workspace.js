// workspace.json (plan 3.4): a public file at the root of the shared folder.
// It holds the workspace id and, for every key id issued, that id encrypted
// with the key, so a keyring can be matched to its folder. No secrets.
import { toBase64, fromBase64 } from "./base64.js";

export const WORKSPACE_FILE = "workspace.json";
const encoder = new TextEncoder();
const AAD = encoder.encode("workspace-check-1");
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

const importRaw = (raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

/** The text of workspace.json for a keyring: one check per key. */
export async function workspaceFileFor(keyring, { random }) {
  const checks = {};
  for (const { id, raw } of keyring.keys) {
    const iv = random.bytes(12);
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, await importRaw(raw), encoder.encode(keyring.workspace));
    checks[id] = { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
  }
  return JSON.stringify({ format: 1, id: keyring.workspace, checks }, null, 2);
}

function parse(text) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(file) || file.format !== 1 || typeof file.id !== "string" || !isRecord(file.checks)) return null;
  const checks = new Map();
  for (const [id, c] of Object.entries(file.checks)) {
    const keyId = Number(id);
    const iv = fromBase64(c?.iv);
    const data = fromBase64(c?.data);
    if (!/^\d{1,3}$/.test(id) || keyId < 1 || keyId > 255 || iv?.length !== 12 || !data) return null;
    checks.set(keyId, { iv, data });
  }
  return checks.size ? { id: file.id, checks } : null;
}

async function opens(check, raw, workspace) {
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: check.iv, additionalData: AAD }, await importRaw(raw), check.data);
    return new TextDecoder().decode(plain) === workspace;
  } catch {
    return false;
  }
}

/**
 * "ok" when the keyring holds exactly the keys this workspace issued;
 * "other-workspace" when the ids differ or a key is not this workspace's;
 * "out-of-date" when the workspace has a key the keyring lacks (a rotation);
 * "bad-file" when the text is not a workspace file.
 */
export async function checkKeyring(keyring, workspaceText) {
  const file = parse(workspaceText);
  if (!file) return "bad-file";
  if (file.id !== keyring.workspace) return "other-workspace";
  for (const { id, raw } of keyring.keys) {
    const check = file.checks.get(id);
    if (!check || !(await opens(check, raw, file.id))) return "other-workspace";
  }
  const held = new Set(keyring.keys.map((k) => k.id));
  return [...file.checks.keys()].every((id) => held.has(id)) ? "ok" : "out-of-date";
}
