// Status files (ADR-0004 section 1): status/<deviceId>.ywb, same envelope,
// no updates; the payload is the metadata block.
import { open, seal } from "./envelope.js";
import { observePeerStatus } from "./health.js";

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function digestOf(T) {
  const json = JSON.stringify(T.adapter.toJSON(T.doc));
  return hex(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)));
}

export async function tableStatus(ctx, T) {
  return {
    ...ctx.layout.tableStatus(T),
    digest: await digestOf(T),
    pending: T.pending.length,
  };
}

export async function writeStatusFile(ctx) {
  const { cfg, rt } = ctx;
  const now = cfg.clock.now();
  const tables = {};
  for (const T of ctx.tables.values()) tables[T.name] = await tableStatus(ctx, T);
  const meta = { kind: "status", user: cfg.user, device: cfg.deviceId, appVersion: cfg.options.appVersion, writtenAt: now, lastActiveAt: now, tables };
  const bytes = await seal({ key: cfg.key, keyId: cfg.keyId, iv: cfg.random.bytes(12), meta, updates: [] });
  await ctx.layout.writeStatus(bytes);
  rt.lastStatusAt = now;
  rt.selfStatus = meta;
}

/**
 * Two devices that report the same applied state must report the same table
 * digest (P11). Devices with unsaved edits are left out (their digest covers
 * edits the applied state does not), and so are layouts that report no applied
 * state. Each distinct disagreement is counted once.
 */
export function checkDigestAgreement(ctx) {
  const metas = [...ctx.rt.statuses.values()].map((s) => s.meta);
  if (ctx.rt.selfStatus) metas.push(ctx.rt.selfStatus);
  const groups = new Map();
  for (const m of metas) {
    for (const [table, t] of Object.entries(m.tables ?? {})) {
      if (t.pending || !Object.keys(t.applied ?? {}).length) continue;
      const key = `${table}|${JSON.stringify(Object.entries(t.applied).sort(([x], [y]) => (x < y ? -1 : 1)))}`; // key order is not meaningful
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(t.digest);
    }
  }
  for (const [key, digests] of groups) if (digests.size > 1) ctx.metrics.mismatch(key);
}

/**
 * Our own status file outlives a wiped local store, so its record of the
 * highest chunk we wrote is evidence for numbering (see saver.initOpenChunk).
 * Read once per engine; an unreadable file is simply no evidence.
 */
async function readOwnStatus(ctx, entry) {
  if (ctx.rt.ownStatus !== undefined) return;
  try {
    const { meta } = await open({ keys: ctx.keys, bytes: await (await ctx.layout.open(entry)).bytes() });
    ctx.rt.ownStatus = meta?.kind === "status" && meta.device === ctx.cfg.deviceId ? meta : null;
  } catch {
    // retried on the next scan
  }
}

const SEEN_KEY = "status-seen";

/** Load, from the local store, when this device last saw each peer's status file change. */
export async function loadStatusSeen(ctx) {
  try {
    ctx.rt.statusSeen = (await ctx.cfg.store.get(SEEN_KEY)) ?? {};
  } catch (err) {
    ctx.recordError("store", err);
  }
}

/**
 * Is this peer active for the acknowledgement rule? Judged by when this device
 * last saw the peer's status file change, on this device's clock, so a peer
 * with a wrong clock still counts while it is alive, and one that has been
 * silent for the whole window stops blocking deletion. A peer never observed
 * counts as active.
 */
export function isPeerActive(ctx, device, now) {
  const seen = ctx.rt.statusSeen[device];
  if (!seen) return true;
  return now - Math.min(seen.at, now) <= ctx.cfg.options.compaction.activeWindowMs;
}

async function persistStatusSeen(ctx) {
  try {
    await ctx.cfg.store.set(SEEN_KEY, ctx.rt.statusSeen);
  } catch (err) {
    ctx.recordError("store", err);
  }
}

/** Read the other devices' status files into ctx.rt.statuses. Never throws. */
export async function readStatusFiles(ctx) {
  const { rt } = ctx;
  let entries = [];
  try {
    entries = await ctx.layout.listStatus();
  } catch (err) {
    ctx.recordError("list", err, { path: "status" });
    return;
  }
  const unreadable = [];
  let seenChanged = false;
  for (const e of entries) {
    if (e.device === ctx.cfg.deviceId) {
      await readOwnStatus(ctx, e);
      continue;
    }
    try {
      const file = await ctx.layout.open(e);
      if (rt.statuses.get(e.device)?.fp === file.fingerprint) continue;
      const { meta } = await open({ keys: ctx.keys, bytes: await file.bytes() });
      if (meta?.kind !== "status" || meta.device !== e.device) {
        if (meta?.kind === "status") ctx.metrics.copySeen(e.path);
        continue; // conflict copy or junk
      }
      rt.statuses = new Map(rt.statuses).set(e.device, { fp: file.fingerprint, meta });
      observePeerStatus(ctx, e.device, meta);
      if (rt.statusSeen[e.device]?.fp !== file.fingerprint) {
        rt.statusSeen = { ...rt.statusSeen, [e.device]: { fp: file.fingerprint, at: ctx.cfg.clock.now() } };
        seenChanged = true;
      }
    } catch (err) {
      unreadable.push({ path: e.path, device: e.device, error: { name: err?.name ?? "Error", message: String(err?.message ?? err) } });
    }
  }
  rt.statusUnreadable = unreadable;
  if (seenChanged) await persistStatusSeen(ctx);
}
