// The admin page's steps that touch the folder or a key file (OUT-10). No DOM,
// so they are tested in Node; the page (main.ts) wires them to its screens.
import { openKeyFile } from "../identity/keyfile.js";
import { checkKeyring, workspaceFileFor, WORKSPACE_FILE } from "../identity/workspace.js";

const MESSAGES = {
  "other-workspace": "This key file is for a different workspace.",
  "out-of-date": "This key file is out of date: the workspace has a newer key. Use the latest key backup.",
  "bad-workspace": "The workspace file in this folder is damaged. You can rewrite it from this key file.",
  "has-workspace": "This folder already has a workspace. Restore only into an empty folder.",
};

export class AdminError extends Error {
  constructor(code, keyring) {
    super(MESSAGES[code]);
    this.name = "AdminError";
    this.code = code;
    if (keyring) this.keyring = keyring;
  }
}

export const backupFileName = (keyring) => `workspace-key-${keyring.current}.keybackup.json`;
export const inviteFileName = (userId) => `${userId}.invite.json`;
export const backupZipName = (stamp) => `backup-${stamp}.zip`;

const describe = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/**
 * workspace.json at the folder's root: missing, found, or unreadable. Never throws.
 * @returns {Promise<{ status: "missing" } | { status: "found", text: string } | { status: "unreadable", message: string }>}
 */
export async function readWorkspace(root) {
  try {
    const file = await (await root.getFileHandle(WORKSPACE_FILE)).getFile();
    return { status: "found", text: new TextDecoder().decode(await file.arrayBuffer()) };
  } catch (error) {
    if (error?.name === "NotFoundError") return { status: "missing" };
    return { status: "unreadable", message: describe(error) };
  }
}

export async function writeWorkspace(root, text) {
  const writable = await (await root.getFileHandle(WORKSPACE_FILE, { create: true })).createWritable();
  await writable.write(new TextEncoder().encode(text));
  await writable.close();
}

/** "passport" when the file says so; anything else is opened as a key backup and refused by the key file's own checks. */
function kindOf(text) {
  try {
    return JSON.parse(text)?.kind === "passport" ? "passport" : "key-backup";
  } catch {
    return "key-backup";
  }
}

/**
 * The keyring in a key backup, or in a passport when the backup is lost (its
 * user is dropped, decision D36), checked against the folder's workspace.json.
 * Throws KeyFileError, or AdminError; a damaged workspace.json carries the keyring for the repair.
 */
export async function openKeyring({ text, passphrase, workspaceText }) {
  const from = kindOf(text);
  const { workspace, current, keys } = await openKeyFile({ text, passphrase, kind: from });
  const keyring = { workspace, current, keys };
  const check = await checkKeyring(keyring, workspaceText);
  if (check === "bad-file") throw new AdminError("bad-workspace", keyring);
  if (check !== "ok") throw new AdminError(check);
  return { keyring, from };
}

/**
 * "Restore into an empty folder" (OUT-48): opens the key backup, has restore
 * (keyring, root, file) put the backup's tables into the folder as this
 * device (the page passes the host's restoreHost), and only then writes
 * workspace.json, so a refused restore leaves the folder as it was.
 * Throws KeyFileError, AdminError, or the restore's BackupError.
 */
export async function restoreWorkspace({ root, text, passphrase, file, restore, random }) {
  const { workspace, current, keys } = await openKeyFile({ text, passphrase, kind: "key-backup" });
  const keyring = { workspace, current, keys };
  if ((await readWorkspace(root)).status !== "missing") throw new AdminError("has-workspace");
  const { tables } = await restore(keyring, root, file);
  await writeWorkspace(root, await workspaceFileFor(keyring, { random }));
  return { keyring, tables };
}
