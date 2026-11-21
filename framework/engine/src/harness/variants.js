// Registry of the variants of spec section 3 and a run-time availability probe.
//
// Each variant is { name, description, options, adapter, expectedUnsafe? }.
// `options` are engine options (merged over the engine defaults).
import { createWorld } from "../sim/world.js";
import { createEngine } from "../engine/engine.js";
import { createMemoryStore } from "../store/memory.js";
import { yjsAdapter } from "../adapters/yjs.js";
import { importFixedKey } from "./keys.js";

const variant = (name, description, options = {}, adapter = "yjs", extra = {}) =>
  Object.freeze({ name, description, options: Object.freeze(options), adapter, ...extra });

export const VARIANTS = Object.freeze([
  variant("baseline", "all engine defaults, Yjs"),
  variant("framed", "chunkContent framed: keep each update separately", { chunkContent: "framed" }),
  variant("seal-16k", "seal chunks at 16 KiB", { sealBytes: 16384 }),
  variant("seal-256k", "seal chunks at 256 KiB", { sealBytes: 262144 }),
  variant("reuse-chunk", "continue the last unsealed chunk each session", { newChunkPerSession: false }),
  variant("eager-save", "quiet 2 s, max wait 10 s, min interval 2 s", { quietMs: 2000, maxWaitMs: 10000, minIntervalMs: 2000 }),
  variant("no-compaction", "compaction disabled", { compaction: { enabled: false } }),
  variant("compact-200", "compact after more than 200 chunks (the former default)", { compaction: { chunkThreshold: 200 } }),
  variant("compact-no-min-age", "snapshots may supersede at once (minSnapshotAgeMs 0)", { compaction: { minSnapshotAgeMs: 0 } }),
  variant("ack-none", "delete as soon as a snapshot exists (expected unsafe)", { compaction: { ackRule: "none" } }, "yjs", { expectedUnsafe: true }),
]);

export const VARIANT_NAMES = Object.freeze(VARIANTS.map((v) => v.name));

export function getVariant(name) {
  const found = VARIANTS.find((v) => v.name === name);
  if (!found) throw new Error(`unknown variant "${name}" (known: ${VARIANT_NAMES.join(", ")})`);
  return found;
}

const probeCache = new Map();

/**
 * Ask the real engine whether it accepts this variant's options. Only an
 * "unsupported layout" refusal means "not available"; any other failure is a
 * real problem and is rethrown. Cached by variant name + options.
 */
export async function probeVariant(v) {
  const cacheKey = `${v.name}:${JSON.stringify(v.options)}`;
  if (probeCache.has(cacheKey)) return probeCache.get(cacheKey);
  const world = createWorld({ seed: 0 });
  const dev = world.addDevice("probe-00000000");
  let result = { available: true };
  try {
    const engine = await createEngine({
      root: dev.root, clock: world.clock, random: world.random("probe"), store: createMemoryStore(),
      key: await importFixedKey(), keyId: 1, user: "probe", deviceId: dev.id,
      adapters: { yjs: yjsAdapter }, tables: { probe: v.adapter }, options: v.options,
    });
    await engine.close();
  } catch (err) {
    if (/unsupported layout/i.test(String(err?.message))) result = { available: false, reason: String(err.message) };
    else throw err;
  }
  probeCache.set(cacheKey, result);
  return result;
}
