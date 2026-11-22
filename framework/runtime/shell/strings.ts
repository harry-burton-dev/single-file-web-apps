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

  // The first-run flow (OUT-36).
  /** Shown when the error has no message written for the user. */
  unexpectedError: string;
  storageUnavailable: string;
  chooseFolder: string;
  reconnectTo: (folder: string) => string;
  folderRefused: string;
  passportIntro: (app: string) => string;
  haveInvite: string;
  havePassport: string;
  inviteFile: string;
  invitePassphrase: string;
  newPassphrase: string;
  confirmPassphrase: string;
  openInvite: string;
  openingInvite: string;
  cancel: string;
  chooseInviteFirst: string;
  passphrasesDiffer: string;
  inviteAccepted: (user: string) => string;
  savePassport: string;
  passportNotSaved: string;
  passphraseFor: (passportFile: string) => string;
  unlock: string;
  unlocking: string;
  switchPassport: string;
  allowPassport: string;
  alreadyOpen: (app: string) => string;
  tryAgain: string;
  /** The reconnect banner's accessible name, and what it says. */
  reconnectTitle: string;
  reconnectBanner: (folder: string) => string;
  reconnect: string;
  reconnected: string;
  newInvite: string;
  signedIn: (user: string, device: string, folder: string) => string;
  version: (version: string, builtAt: string) => string;

  /** The update notice: a new version is cached and runs on the next load. */
  updateReady: (version: string) => string;
  loadUpdate: string;
  /** A release was refused; the reason is the loader's own message. */
  updateRefused: (reason: string) => string;

  /** The conflict prompt: the count in the health area, and the list it opens. */
  needsDecision: (count: number) => string;
  decisionsTitle: string;
  /** One conflict, by the table and field names in the app definition. */
  conflictAbout: (table: string, id: string, field: string) => string;
  keep: (value: string) => string;
  writtenBy: (user: string, time: string) => string;
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

  unexpectedError: "Unexpected error",
  storageUnavailable: "This browser would not open its local storage, which the app needs. A private window or blocked site data can cause this.",
  chooseFolder: "Choose the shared folder",
  reconnectTo: (folder) => `Reconnect to "${folder}"`,
  folderRefused: "Allow access to the folder to continue.",
  passportIntro: (app) => `To open ${app} on this computer you need an invite from the admin, or the passport you saved from one.`,
  haveInvite: "I have an invite",
  havePassport: "I have a passport",
  inviteFile: "Invite file from the admin",
  invitePassphrase: "The invite's passphrase (from the admin)",
  newPassphrase: "Choose your own passphrase (at least 12 characters)",
  confirmPassphrase: "Type it again",
  openInvite: "Open the invite",
  openingInvite: "Opening the invite",
  cancel: "Cancel",
  chooseInviteFirst: "Choose the invite file first.",
  passphrasesDiffer: "The two new passphrases do not match.",
  inviteAccepted: (user) =>
    `Invite accepted for ${user}. Save your passport somewhere on this computer, not in the shared folder. You will choose it once and then type your passphrase at each launch. The invite file can then be deleted.`,
  savePassport: "Save my passport",
  passportNotSaved: "The passport was not saved. Save it to continue.",
  passphraseFor: (passportFile) => `Passphrase for your passport "${passportFile}"`,
  unlock: "Unlock",
  unlocking: "Unlocking",
  switchPassport: "Use another passport or an invite",
  allowPassport: "Allow access to your passport file to continue.",
  alreadyOpen: (app) => `${app} is already open in another tab. Close it there, then try again.`,
  tryAgain: "Try again",
  reconnectTitle: "Folder access",
  reconnectBanner: (folder) => `This browser no longer has access to "${folder}". Your changes are safe on this computer and will be shared once you reconnect.`,
  reconnect: "Reconnect",
  reconnected: "Reconnected. Catching up with the folder.",
  newInvite: "Open a new invite",
  signedIn: (user, device, folder) => `${user}, device ${device}, folder "${folder}"`,
  version: (version, builtAt) => `Version ${version}, built ${builtAt}.`,
  updateReady: (version) => `Version ${version} is ready.`,
  loadUpdate: "Load it",
  updateRefused: (reason) => `A new version was not installed. ${reason}`,
  needsDecision: (count) => (count === 1 ? "1 needs a decision" : `${count} need a decision`),
  decisionsTitle: "Needs a decision",
  conflictAbout: (table, id, field) => `${field} of ${table} ${id}`,
  keep: (value) => `Keep "${value}"`,
  writtenBy: (user, time) => `${user}, ${time}`,
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
