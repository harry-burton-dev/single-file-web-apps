// Connecting to the shared folder: pick it once, remember the handle, and
// re-check permission on every start (the browser can let it lapse).
import type { KeyValueDb } from "./idb";

const HANDLE_KEY = "host/folder-handle";

export type FolderState =
  | { status: "none" }
  | { status: "needs-permission"; handle: FileSystemDirectoryHandle }
  | { status: "ready"; handle: FileSystemDirectoryHandle };

const READ_WRITE = { mode: "readwrite" } as const;

/** The folder remembered from a previous visit, without prompting the user. */
export async function loadFolder(db: KeyValueDb): Promise<FolderState> {
  const handle = (await db.get(HANDLE_KEY)) as FileSystemDirectoryHandle | undefined;
  if (!handle) return { status: "none" };
  const permission = await handle.queryPermission(READ_WRITE);
  return permission === "granted" ? { status: "ready", handle } : { status: "needs-permission", handle };
}

/** Ask the browser to restore access. Must be called from a click. */
export async function regrant(handle: FileSystemDirectoryHandle): Promise<FolderState> {
  const permission = await handle.requestPermission(READ_WRITE);
  return permission === "granted" ? { status: "ready", handle } : { status: "needs-permission", handle };
}

/** Show the folder picker. Must be called from a click. Returns "none" if cancelled. */
export async function pickFolder(db: KeyValueDb, pickerId: string): Promise<FolderState> {
  try {
    const handle = await window.showDirectoryPicker({ id: pickerId, ...READ_WRITE });
    await db.set(HANDLE_KEY, handle);
    return { status: "ready", handle };
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") return { status: "none" };
    throw error;
  }
}

export async function forgetFolder(db: KeyValueDb): Promise<void> {
  await db.delete(HANDLE_KEY);
}
