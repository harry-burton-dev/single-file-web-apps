// The first-run flow as a pure reducer (plan section 3.2). Components run the
// side effects through the shell's services and report what happened as an
// event; this decides the next state. Messages arrive already worded, so the
// reducer knows no strings. An event that does not apply to the current
// state leaves it as it is (the same object).
import type { Data } from "../../data/runtime";
import type { Engine } from "../host/engine-types";
import type { FolderState } from "../host/folder";
import type { HostStart } from "../host/host";
import type { KeyValueDb } from "../host/idb";
import type { PassportState } from "../host/passport-file";
import type { Identity } from "../identity/types";

export interface Session {
  engine: Engine;
  /** The data runtime the screens read and write through; made once per engine. */
  data: Data;
  stop: () => Promise<void>;
  deviceId: string;
  user: Identity["user"];
}

type Root = FileSystemDirectoryHandle;

export type ShellState =
  | { phase: "starting" }
  | { phase: "folder"; db: KeyValueDb; folder: Exclude<FolderState, { status: "ready" }>; message?: string }
  | { phase: "passport"; db: KeyValueDb; root: Root; message?: string }
  | { phase: "unlock"; db: KeyValueDb; root: Root; passport: Exclude<PassportState, { status: "none" }>; message?: string }
  | { phase: "already-open"; db: KeyValueDb; root: Root; identity: Identity }
  /** reconnect: "needed" while the folder has lost permission; "granted" until the next folder operation succeeds. */
  | { phase: "running"; db: KeyValueDb; root: Root; session: Session; reconnect: "none" | "needed" | "granted"; message?: string }
  | { phase: "failed"; message: string; detail?: string };

/** A started host with its data runtime; stop() closes both. */
export type Started = Extract<HostStart, { ok: true }> & { data: Data };

export type ShellEvent =
  /** The folder was looked up, picked or regranted; the passport was looked up once the folder is ready. */
  | { type: "folder"; db: KeyValueDb; folder: FolderState; passport: PassportState; message?: string }
  | { type: "passport"; passport: PassportState; message?: string }
  | { type: "started"; identity: Identity; result: Started | Extract<HostStart, { ok: false }> }
  | { type: "message"; message: string }
  | { type: "health"; disconnected: boolean; permission: PermissionState }
  | { type: "regranted"; granted: boolean; message?: string }
  | { type: "failed"; message: string; detail?: string };

const withMessage = <T extends object>(state: T, message?: string): T => (message === undefined ? state : { ...state, message });

export function reduce(state: ShellState, event: ShellEvent): ShellState {
  switch (event.type) {
    case "failed":
      return { phase: "failed", message: event.message, detail: event.detail };
    case "folder": {
      if (state.phase !== "starting" && state.phase !== "folder") return state;
      const { db, folder, passport } = event;
      if (folder.status !== "ready") return withMessage({ phase: "folder", db, folder }, event.message);
      if (passport.status === "none") return { phase: "passport", db, root: folder.handle };
      return { phase: "unlock", db, root: folder.handle, passport };
    }
    case "passport": {
      if (state.phase !== "passport" && state.phase !== "unlock") return state;
      const { db, root } = state;
      if (event.passport.status === "none") return withMessage({ phase: "passport", db, root }, event.message);
      return withMessage({ phase: "unlock", db, root, passport: event.passport }, event.message);
    }
    case "started": {
      if (state.phase !== "passport" && state.phase !== "unlock" && state.phase !== "already-open" && state.phase !== "running") return state;
      const { db, root } = state;
      const { identity, result } = event;
      if (!result.ok) return { phase: "already-open", db, root, identity };
      return { phase: "running", db, root, session: { engine: result.engine, data: result.data, stop: result.stop, deviceId: result.deviceId, user: identity.user }, reconnect: "none" };
    }
    case "message":
      return state.phase === "starting" || state.phase === "failed" || state.phase === "already-open" ? state : { ...state, message: event.message };
    case "health": {
      if (state.phase !== "running") return state;
      if (!event.disconnected) return state.reconnect === "none" ? state : { ...state, reconnect: "none", message: undefined };
      if (event.permission !== "granted" && state.reconnect === "none") return { ...state, reconnect: "needed" };
      return state;
    }
    case "regranted": {
      if (state.phase !== "running" || state.reconnect !== "needed") return state;
      if (event.granted) return { ...state, reconnect: "granted", message: undefined };
      return withMessage(state, event.message);
    }
  }
}
