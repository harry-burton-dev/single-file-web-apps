// The host layer: everything the engine deliberately does not do for itself.
// Real clock, randomness and timer; the IndexedDB store; one-tab-per-device
// locking; the once-a-second tick; flush when the page is hidden; and the
// browser's online/offline hint.
import { createEngine } from "../../engine/src/engine/engine.js";
import { createYjsAdapter } from "../../engine/src/adapters/yjs.js";
import type { AppDefinition } from "../definition";
import { appNames } from "../names.ts";
import { USERS_TABLE } from "../identity/admin.js";
import { restoreBackup } from "../backup/backup.js";
import type { Engine } from "./engine-types";
import type { KeyValueDb } from "./idb";

const TICK_MS = 1000;
const DEVICE_KEY = "host/device-id";
const ENGINE_PREFIX = "engine/";
const DEVICE_SUFFIX_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const DEVICE_SUFFIX_LENGTH = 8;

export interface HostConfig {
  root: FileSystemDirectoryHandle;
  db: KeyValueDb;
  user: string;
  key: CryptoKey;
  keyId: number;
  /** Extra keys to read with, by key id, so data from before a rotation stays readable. */
  keys?: Map<number, CryptoKey>;
  app: AppDefinition;
}

export type HostStart =
  /** clock and random are the ones the engine was given, for the data runtime (createData). */
  | { ok: true; engine: Engine; deviceId: string; clock: { now(): number }; random: { bytes(n: number): Uint8Array }; stop: () => Promise<void> }
  | { ok: false; reason: "already-open" };

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

const clock = { now: () => Date.now() };

const random = {
  bytes: randomBytes,
  float: (): number => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 2 ** 32,
};

/** This browser profile's device id: "<user>-<8 chars>", created once and kept. */
async function deviceIdFor(db: KeyValueDb, user: string): Promise<string> {
  const saved = await db.get(DEVICE_KEY);
  if (typeof saved === "string" && saved.startsWith(`${user}-`)) return saved;
  const suffix = Array.from(randomBytes(DEVICE_SUFFIX_LENGTH), (b) => DEVICE_SUFFIX_CHARS[b % DEVICE_SUFFIX_CHARS.length]).join("");
  const id = `${user}-${suffix}`;
  await db.set(DEVICE_KEY, id);
  return id;
}

/** The engine's local store (spec 2.3), kept under its own key prefix. */
function engineStore(db: KeyValueDb) {
  return {
    get: (key: string) => db.get(ENGINE_PREFIX + key),
    set: (key: string, value: unknown) => db.set(ENGINE_PREFIX + key, value),
    delete: (key: string) => db.delete(ENGINE_PREFIX + key),
    keys: async (prefix = "") => (await db.keys(ENGINE_PREFIX + prefix)).map((k) => k.slice(ENGINE_PREFIX.length)),
  };
}

/**
 * Holds a Web Lock for as long as this tab runs the device, so a second tab
 * cannot write the same device's chunk files. Resolves false if another tab has it.
 */
function holdDeviceLock(lockName: string): Promise<{ held: boolean; release: () => void }> {
  return new Promise((resolve) => {
    void navigator.locks.request(lockName, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve({ held: false, release: () => undefined });
        return undefined;
      }
      return new Promise<void>((release) => resolve({ held: true, release }));
    });
  });
}

/** The engine's tables and adapters for this app, as writeBackup takes them. */
export function engineTables(app: AppDefinition) {
  return {
    adapters: { yjs: createYjsAdapter({ random }) },
    // The app's tables, and the framework's users table (decision D17).
    tables: Object.fromEntries([...Object.keys(app.tables), USERS_TABLE].map((table) => [table, "yjs"])) as Record<string, string>,
  };
}

/** Everything createEngine takes for this device, apart from the folder. */
function engineConfig(config: HostConfig, deviceId: string) {
  return {
    clock,
    timer: { now: () => performance.now() },
    random,
    store: engineStore(config.db),
    key: config.key,
    keyId: config.keyId,
    keys: config.keys,
    user: config.user,
    deviceId,
    ...engineTables(config.app),
  };
}

export async function startHost(config: HostConfig): Promise<HostStart> {
  const deviceId = await deviceIdFor(config.db, config.user);
  const lock = await holdDeviceLock(appNames(config.app).deviceLock(deviceId));
  if (!lock.held) return { ok: false, reason: "already-open" };

  const engine = (await createEngine({ root: config.root, ...engineConfig(config, deviceId) })) as unknown as Engine;
  engine.setOffline(!navigator.onLine);

  let ticking = false;
  const tick = async (): Promise<void> => {
    if (ticking) return; // a slow folder must not queue ticks up behind each other
    ticking = true;
    try {
      await engine.tick();
    } finally {
      ticking = false;
    }
  };
  const interval = window.setInterval(() => void tick(), TICK_MS);

  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") void engine.flush();
  };
  const onOnline = (): void => engine.setOffline(false);
  const onOffline = (): void => engine.setOffline(true);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onVisibility);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  const stop = async (): Promise<void> => {
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onVisibility);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    await engine.close();
    lock.release();
  };

  return { ok: true, engine, deviceId, clock, random, stop };
}

/**
 * Restores a backup file into config.root as this browser's device (OUT-48):
 * the same store, device id and lock as startHost, so a startHost there
 * afterwards carries on from the restored data. Throws restoreBackup's BackupError.
 */
export async function restoreHost(config: HostConfig, file: Uint8Array): Promise<{ ok: true; tables: string[] } | { ok: false; reason: "already-open" }> {
  const deviceId = await deviceIdFor(config.db, config.user);
  const lock = await holdDeviceLock(appNames(config.app).deviceLock(deviceId));
  if (!lock.held) return { ok: false, reason: "already-open" };
  try {
    const { tables } = await restoreBackup({ root: config.root, file, engineConfig: engineConfig(config, deviceId) });
    return { ok: true, tables };
  } finally {
    lock.release();
  }
}
