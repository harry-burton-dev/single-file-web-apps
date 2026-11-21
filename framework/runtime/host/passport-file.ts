// The user's passport file (TR3 decisions D4 to D6): saved once on the user's
// own machine, its handle remembered so later launches only ask for the
// passphrase. The handle is the only thing kept here; never a key.
import { WORKSPACE_FILE } from "../identity/workspace.js";
import type { KeyValueDb } from "./idb";

const HANDLE_KEY = "host/passport-handle";
const READ = { mode: "read" } as const;
const JSON_FILES = [{ description: "Passport", accept: { "application/json": [".json"] } }];

export type PassportState =
  | { status: "none" }
  | { status: "needs-permission"; handle: FileSystemFileHandle }
  | { status: "ready"; handle: FileSystemFileHandle };

const cancelled = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

async function stateOf(handle: FileSystemFileHandle): Promise<PassportState> {
  return (await handle.queryPermission(READ)) === "granted" ? { status: "ready", handle } : { status: "needs-permission", handle };
}

/** The passport remembered from a previous visit, without prompting the user. */
export async function loadPassport(db: KeyValueDb): Promise<PassportState> {
  const handle = (await db.get(HANDLE_KEY)) as FileSystemFileHandle | undefined;
  return handle ? stateOf(handle) : { status: "none" };
}

/** Ask the browser to restore read access. Must be called from a click. */
export async function regrantPassport(handle: FileSystemFileHandle): Promise<Exclude<PassportState, { status: "none" }>> {
  return (await handle.requestPermission(READ)) === "granted" ? { status: "ready", handle } : { status: "needs-permission", handle };
}

/** Show the save picker, write the passport and remember it. Must be called from a click. "none" if cancelled. */
export async function savePassport(db: KeyValueDb, passport: { passportText: string; fileName: string }): Promise<PassportState> {
  let handle: FileSystemFileHandle;
  try {
    handle = await window.showSaveFilePicker({ suggestedName: passport.fileName, types: JSON_FILES });
  } catch (error: unknown) {
    if (cancelled(error)) return { status: "none" };
    throw error;
  }
  const writable = await handle.createWritable();
  await writable.write(passport.passportText);
  await writable.close();
  await db.set(HANDLE_KEY, handle);
  return { status: "ready", handle };
}

/** Show the open picker for a passport saved earlier and remember it. Must be called from a click. "none" if cancelled. */
export async function pickPassport(db: KeyValueDb): Promise<PassportState> {
  let handle: FileSystemFileHandle | undefined;
  try {
    [handle] = await window.showOpenFilePicker({ types: JSON_FILES });
  } catch (error: unknown) {
    if (cancelled(error)) return { status: "none" };
    throw error;
  }
  if (!handle) return { status: "none" };
  await db.set(HANDLE_KEY, handle);
  return stateOf(handle);
}

export async function readPassport(handle: FileSystemFileHandle): Promise<string> {
  return (await handle.getFile()).text();
}

export async function forgetPassport(db: KeyValueDb): Promise<void> {
  await db.delete(HANDLE_KEY);
}

/** The text of workspace.json at the folder's root, or null when the folder has none. */
export async function readWorkspaceFile(root: FileSystemDirectoryHandle): Promise<string | null> {
  try {
    return await (await (await root.getFileHandle(WORKSPACE_FILE)).getFile()).text();
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}
