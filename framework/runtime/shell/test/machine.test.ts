// The first-run flow's transition table (plan section 3.2), including the
// unhappy moves: picker cancelled, permission refused, wrong passphrase,
// second tab, local storage unavailable, permission lost while running.
import { describe, expect, test } from "vitest";
import { reduce, type ShellEvent, type ShellState } from "../machine";
import type { KeyValueDb } from "../../host/idb";
import type { Identity } from "../../identity/types";
import type { Engine } from "../../host/engine-types";
import type { Data } from "../../../data/runtime";

const db = { name: "db" } as unknown as KeyValueDb;
const root = { name: "shared" } as FileSystemDirectoryHandle;
const passportHandle = { name: "sam.passport.json" } as FileSystemFileHandle;
const identity = { user: { id: "sam", name: "Sam" } } as Identity;
const engine = { name: "engine" } as unknown as Engine;
const data = { name: "data" } as unknown as Data;
const stop = async () => undefined;
const session = { engine, data, stop, deviceId: "d1", user: identity.user };

const starting: ShellState = { phase: "starting" };
const folderNone: ShellState = { phase: "folder", db, folder: { status: "none" } };
const folderLapsed: ShellState = { phase: "folder", db, folder: { status: "needs-permission", handle: root } };
const passport: ShellState = { phase: "passport", db, root };
const unlock: ShellState = { phase: "unlock", db, root, passport: { status: "ready", handle: passportHandle } };
const alreadyOpen: ShellState = { phase: "already-open", db, root, identity };
const running: ShellState = { phase: "running", db, root, session, reconnect: "none" };
const needsReconnect: ShellState = { ...running, reconnect: "needed" };
const granted: ShellState = { ...running, reconnect: "granted" };

const ready = { status: "ready", handle: root } as const;
const noPassport = { status: "none" } as const;
const savedPassport = { status: "ready", handle: passportHandle } as const;
const started = { ok: true, engine, data, stop, deviceId: "d1", clock: { now: () => 0 }, random: { bytes: (n: number) => new Uint8Array(n) } } as const;

type Row = [string, ShellState, ShellEvent, ShellState];

const TABLE: Row[] = [
  // start-up
  ["no folder remembered", starting, { type: "folder", db, folder: { status: "none" }, passport: noPassport }, folderNone],
  ["remembered folder lapsed", starting, { type: "folder", db, folder: { status: "needs-permission", handle: root }, passport: noPassport }, folderLapsed],
  ["folder ready, no passport", starting, { type: "folder", db, folder: ready, passport: noPassport }, passport],
  ["folder ready, passport remembered", starting, { type: "folder", db, folder: ready, passport: savedPassport }, unlock],
  ["local storage unavailable", starting, { type: "failed", message: "no storage", detail: "UnknownError: x" }, { phase: "failed", message: "no storage", detail: "UnknownError: x" }],
  // folder
  ["picker cancelled stays", folderNone, { type: "folder", db, folder: { status: "none" }, passport: noPassport }, folderNone],
  ["permission refused stays, with its message", folderLapsed, { type: "folder", db, folder: { status: "needs-permission", handle: root }, passport: noPassport, message: "refused" }, { ...folderLapsed, message: "refused" }],
  ["folder picked", folderNone, { type: "folder", db, folder: ready, passport: noPassport }, passport],
  ["permission granted", folderLapsed, { type: "folder", db, folder: ready, passport: savedPassport }, unlock],
  // passport and invite
  ["passport chosen", passport, { type: "passport", passport: savedPassport }, unlock],
  ["passport picker cancelled stays", passport, { type: "passport", passport: noPassport }, passport],
  ["use another passport", unlock, { type: "passport", passport: noPassport }, passport],
  ["wrong passphrase stays, with its message", unlock, { type: "message", message: "That passphrase does not open this file." }, { ...unlock, message: "That passphrase does not open this file." }],
  ["passport permission refused stays", unlock, { type: "passport", passport: { status: "needs-permission", handle: passportHandle }, message: "allow" }, { ...unlock, passport: { status: "needs-permission", handle: passportHandle }, message: "allow" }],
  ["invite accepted, engine started", passport, { type: "started", identity, result: started }, running],
  ["unlocked, engine started", unlock, { type: "started", identity, result: started }, running],
  // second tab
  ["second tab", unlock, { type: "started", identity, result: { ok: false, reason: "already-open" } }, alreadyOpen],
  ["second tab, still open", alreadyOpen, { type: "started", identity, result: { ok: false, reason: "already-open" } }, alreadyOpen],
  ["second tab closed, try again", alreadyOpen, { type: "started", identity, result: started }, running],
  // running: permission lost mid-session
  ["folder disconnected, permission lapsed", running, { type: "health", disconnected: true, permission: "prompt" }, needsReconnect],
  ["folder disconnected, permission still granted", running, { type: "health", disconnected: true, permission: "granted" }, running],
  ["refused at the banner stays, with its message", needsReconnect, { type: "regranted", granted: false, message: "refused" }, { ...needsReconnect, message: "refused" }],
  ["granted at the banner: waits for the next folder operation", needsReconnect, { type: "regranted", granted: true }, granted],
  ["granted, still disconnected", granted, { type: "health", disconnected: true, permission: "granted" }, granted],
  ["granted, folder operation succeeded", granted, { type: "health", disconnected: false, permission: "granted" }, running],
  ["new invite while running restarts", running, { type: "started", identity, result: started }, running],
  ["new invite while running, tab conflict", running, { type: "started", identity, result: { ok: false, reason: "already-open" } }, alreadyOpen],
  ["an error after start-up", running, { type: "failed", message: "boom" }, { phase: "failed", message: "boom" }],
];

describe("first-run transitions", () => {
  test.each(TABLE)("%s", (_name, from, event, to) => {
    expect(reduce(from, event)).toEqual(to);
  });

  test("a message clears on the next move", () => {
    expect(reduce({ ...unlock, message: "old" }, { type: "passport", passport: noPassport })).toEqual(passport);
  });

  test("events that do not apply leave the state as it is", () => {
    const ignored: [ShellState, ShellEvent][] = [
      [starting, { type: "passport", passport: savedPassport }],
      [starting, { type: "message", message: "x" }],
      [folderNone, { type: "started", identity, result: started }],
      [passport, { type: "health", disconnected: true, permission: "prompt" }],
      [running, { type: "regranted", granted: true }],
      [{ phase: "failed", message: "x" }, { type: "folder", db, folder: ready, passport: noPassport }],
    ];
    for (const [state, event] of ignored) expect(reduce(state, event), `${state.phase} ${event.type}`).toBe(state);
  });
});
