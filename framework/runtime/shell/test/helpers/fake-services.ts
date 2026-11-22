// Stand-in side effects for the first-run flow: every service resolves at
// once with a happy result unless the test overrides it. `calls` records
// which services ran, in order.
import type { ShellServices } from "../../services";
import type { KeyValueDb } from "../../../host/idb";
import type { Identity } from "../../../identity/types";
import { fakeEngine, type FakeEngine } from "./fake-engine";

export const FOLDER = "shared-folder";
export const PASSPORT_FILE = "sam.passport.json";
export const USER = "Sam Smith";
export const DEVICE = "d1";

export const folderHandle = { kind: "directory", name: FOLDER } as FileSystemDirectoryHandle;
export const passportHandle = { kind: "file", name: PASSPORT_FILE } as FileSystemFileHandle;
export const identity = { user: { id: "sam", name: USER }, keyId: 1, key: {} as CryptoKey, keys: new Map() } as Identity;

function memoryDb(): KeyValueDb {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => void map.set(key, value),
    delete: async (key) => void map.delete(key),
    keys: async () => [...map.keys()],
  };
}

export interface Fakes {
  services: ShellServices;
  calls: string[];
  engines: FakeEngine[];
}

export function fakeServices(overrides: Partial<ShellServices> = {}): Fakes {
  const calls: string[] = [];
  const engines: FakeEngine[] = [];
  const db = memoryDb();
  const ready = { status: "ready", handle: folderHandle } as const;
  const record =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      calls.push(name);
      return fn(...args);
    };
  const base: ShellServices = {
    openDb: async () => db,
    loadFolder: async () => ready,
    pickFolder: async () => ready,
    regrant: async () => ready,
    folderPermission: async () => "granted",
    privateFolder: async () => ready,
    loadPassport: async () => ({ status: "none" }),
    pickPassport: async () => ({ status: "ready", handle: passportHandle }),
    savePassport: async () => ({ status: "ready", handle: passportHandle }),
    regrantPassport: async () => ({ status: "ready", handle: passportHandle }),
    readPassport: async () => "passport text",
    forgetPassport: async () => undefined,
    readWorkspaceFile: async () => "workspace text",
    enrol: async () => ({ passportText: "passport text", fileName: PASSPORT_FILE }),
    unlock: async () => identity,
    startHost: async () => {
      const engine = fakeEngine();
      engines.push(engine);
      return { ok: true, engine, deviceId: DEVICE, clock: { now: () => 0 }, random: { bytes: (n: number) => new Uint8Array(n) }, stop: async () => void calls.push("stop") };
    },
    loader: () => undefined,
  };
  const merged = { ...base, ...overrides };
  const services = Object.fromEntries(Object.entries(merged).map(([name, fn]) => [name, record(name, fn as (...args: unknown[]) => unknown)])) as unknown as ShellServices;
  return { services, calls, engines };
}
