// Every side effect the first-run flow needs, as one object. The real ones are
// the default; component tests pass fakes. `loader` is set by mount() when
// the bootstrap started the bundle, and is absent in development.
import { startHost } from "../host/host";
import { loadFolder, pickFolder, regrant } from "../host/folder";
import { openDb } from "../host/idb";
import { forgetPassport, loadPassport, pickPassport, readPassport, readWorkspaceFile, regrantPassport, savePassport } from "../host/passport-file";
import { enrol, unlock } from "../identity/passport.js";
import type { FolderState } from "../host/folder";
import type { LoaderServices } from "../loader/contract";
import type { Identity } from "../identity/types";

const READ_WRITE = { mode: "readwrite" } as const;
const random = { bytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)) };

let loaderServices: LoaderServices | undefined;

export function setLoader(next: LoaderServices): void {
  loaderServices = next;
}

export const realServices = {
  openDb,
  loadFolder,
  pickFolder,
  regrant,
  /** Whether the folder still has permission, without prompting. */
  folderPermission: (handle: FileSystemDirectoryHandle): Promise<PermissionState> => handle.queryPermission(READ_WRITE),
  /** Development only: the browser's private file area, so the page can be exercised without a folder picker. */
  privateFolder: async (appId: string): Promise<FolderState> => {
    const origin = await navigator.storage.getDirectory();
    return { status: "ready", handle: await origin.getDirectoryHandle(`${appId}-test`, { create: true }) };
  },
  loadPassport,
  pickPassport,
  savePassport,
  regrantPassport,
  readPassport,
  forgetPassport,
  readWorkspaceFile,
  enrol: (args: { inviteText: string; invitePassphrase: string; newPassphrase: string }): Promise<{ passportText: string; fileName: string }> => enrol({ ...args, random }),
  unlock: (args: { passportText: string; passphrase: string; workspaceText: string | null }): Promise<Identity> => unlock(args),
  startHost,
  loader: (): LoaderServices | undefined => loaderServices,
};

export type ShellServices = typeof realServices;
