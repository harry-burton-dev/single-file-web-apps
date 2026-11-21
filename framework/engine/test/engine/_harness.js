// Shared test harness: several engines on one in-memory folder and one
// manual clock. Not a test file (it defines no tests).
import { createEngine } from "../../src/engine/engine.js";
import { createMemoryStore } from "../../src/store/memory.js";
import { yjsAdapter } from "../../src/adapters/yjs.js";
import { createMemFolder, createManualClock, createSeededRandom, testKey } from "../helpers/memfolder.js";

export const EAGER = { quietMs: 2000, maxWaitMs: 10000, minIntervalMs: 2000, scanMs: 1000, statusMs: 5000 };

export async function makeWorld({ tables = { notes: "yjs" }, options = {} } = {}) {
  const clock = createManualClock();
  const folder = createMemFolder({ clock });
  const random = createSeededRandom(42);
  const key = await testKey();
  const stores = new Map();
  const world = {
    clock, folder, key, random, tables, stores, engines: [],
    store(id) {
      if (!stores.has(id)) stores.set(id, createMemoryStore());
      return stores.get(id);
    },
    async device(id, extra = {}) {
      const engine = await createEngine({
        root: extra.root ?? folder.root, clock: extra.clock ?? clock, random, store: extra.store ?? world.store(id), key, keyId: 1,
        user: id.split("-")[0], deviceId: id, adapters: extra.adapters ?? { yjs: yjsAdapter }, tables,
        options: { ...EAGER, ...options, ...(extra.options ?? {}) }, timer: extra.timer, listeners: extra.listeners,
      });
      world.engines.push(engine);
      return engine;
    },
    /** Advance time in 1 s steps, ticking every given engine each step. */
    async run(engines, ms, step = 1000) {
      for (let t = 0; t < ms; t += step) {
        clock.advance(step);
        for (const e of engines) await e.tick();
      }
    },
  };
  return world;
}

export const json = (engine, table = "notes") => engine.table(table) && engineJson(engine, table);
function engineJson(engine, table) {
  return yjsAdapter.toJSON(engine.table(table));
}
