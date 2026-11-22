// Shared fixture for data-layer tests: engines on one memory folder, opened
// through the registry for a given app definition. Not a test file.
import { makeWorld } from "../../engine/test/engine/_harness.js";
import { openRegistry } from "../registry.ts";
import { createData } from "../runtime.ts";

export const engineTables = (config) => Object.fromEntries(Object.keys(config.tables).map((name) => [name, "yjs"]));

export async function makeDataWorld(config, options) {
  const world = await makeWorld({ tables: engineTables(config), options });
  return Object.assign(world, {
    config,
    /** A device's engine and its registry. */
    async open(deviceId) {
      const engine = await world.device(deviceId);
      const registry = openRegistry(engine, config, { deviceId, user: deviceId.split("-")[0], clock: world.clock, random: world.random });
      return { engine, registry };
    },
    /** A device's engine and its data runtime, with the world's clock and seeded random. */
    async data(deviceId, commands) {
      const engine = await world.device(deviceId);
      const data = createData({ engine, config, commands, deviceId, user: deviceId.split("-")[0], clock: world.clock, random: world.random });
      return { engine, data };
    },
  });
}

/** An app with one table of each field kind, typed and plain. */
export const notesApp = {
  id: "notes-app",
  name: "Notes",
  tables: {
    notes: { version: 1, fields: { title: { kind: "latest", type: "string" }, room: { kind: "ask", type: "string" }, body: { kind: "text" } } },
    tags: { version: 2, fields: { label: "latest", owner: "ask", note: "text" } },
  },
};
