// Every word the shell shows (spec S4, "Defaults chosen" 2). An app rewords
// any entry through the shell's `strings` prop, without editing the framework.
// Entries that carry data are functions.
import type { HealthState } from "../host/engine-types";

export interface HealthWording {
  /** Short, for the indicator's badge. */
  label: string;
  /** One plain sentence: what it means for the person's work. */
  sentence: string;
}

export interface ShellStrings {
  health: Record<HealthState, HealthWording>;
  /** The indicator before the engine has started. */
  starting: string;
  waiting: (count: number) => string;
  lastSave: (time: string) => string;
  lastFolderRead: (time: string) => string;
  peerHeard: (user: string, time: string) => string;
  /** A time that has not happened yet, as in "Last save never". */
  never: string;
  notAvailable: string;
  milliseconds: (value: number) => string;

  /** The indicator's menu (its accessible name) and its one item. */
  healthMenu: string;
  diagnostics: string;
  close: string;

  saveNow: string;
  readFolderNow: string;
  saveTime: string;
  folderReadTime: string;
  backlog: string;
  backlogValue: (changes: number, bytes: number, unreadableFiles: number) => string;
  conflicts: string;
  conflictsValue: (open: number, overlaps: number, copies: number, digestMismatches: number) => string;
  errors: string;
  /** The column headings of the sync attempts list and of an attempt's file steps. */
  attemptsLabel: string;
  noSyncAttempts: string;
  noFileActivity: string;

  errorTitle: string;
  openDiagnostics: string;

  // The first-run flow (OUT-36), the update notice (OUT-37) and the conflict
  // prompt (OUT-38) add their entries here.
}

export const defaultStrings: ShellStrings = {
  health: {
    saved: { label: "Saved", sentence: "Your changes are saved to the shared folder." },
    saving: { label: "Saving", sentence: "Your latest changes are being saved to the shared folder." },
    retrying: { label: "Retrying", sentence: "Saving to the shared folder failed and will be tried again shortly. Your changes are safe on this computer." },
    "folder-disconnected": {
      label: "Folder disconnected",
      sentence: "Folder disconnected. Your changes are safe on this computer and will be shared once the folder is reconnected.",
    },
    "not-reaching-peers": { label: "Not reaching colleagues", sentence: "Your changes are saved, but colleagues' copies have not picked them up yet." },
    offline: { label: "Offline", sentence: "You are offline. Your changes are safe on this computer and will be shared when you are back online." },
  },
  starting: "Starting",
  waiting: (count) => `${count} waiting`,
  lastSave: (time) => `Last save ${time}`,
  lastFolderRead: (time) => `Last folder read ${time}`,
  peerHeard: (user, time) => `${user} heard ${time}`,
  never: "never",
  notAvailable: "n/a",
  milliseconds: (value) => `${Math.round(value)} ms`,

  healthMenu: "Sync status",
  diagnostics: "Diagnostics",
  close: "Close",

  saveNow: "Save now",
  readFolderNow: "Read folder now",
  saveTime: "Save time (last / average / 95th)",
  folderReadTime: "Folder read time (last / average / 95th)",
  backlog: "Backlog",
  backlogValue: (changes, bytes, unreadable) => `${changes} changes, ${bytes} bytes, ${unreadable} unreadable files`,
  conflicts: "Conflicts",
  conflictsValue: (open, overlaps, copies, mismatches) => `${open} open, ${overlaps} overlaps, ${copies} conflict copies, ${mismatches} digest mismatches`,
  errors: "Errors",
  attemptsLabel: "Sync attempts, newest first",
  noSyncAttempts: "No sync attempts yet.",
  noFileActivity: "No file activity.",

  errorTitle: "Something went wrong",
  openDiagnostics: "Open diagnostics",
};

/** What an app passes to reword the shell: any entries, and any part of a health state's wording. */
export type ShellStringOverrides = Partial<Omit<ShellStrings, "health">> & {
  health?: Partial<Record<HealthState, Partial<HealthWording>>>;
};

export function mergeStrings(overrides: ShellStringOverrides = {}): ShellStrings {
  const { health = {}, ...rest } = overrides;
  const merged = { ...defaultStrings.health };
  for (const [state, wording] of Object.entries(health) as [HealthState, Partial<HealthWording>][]) merged[state] = { ...merged[state], ...wording };
  return { ...defaultStrings, ...rest, health: merged };
}
