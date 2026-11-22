// Health (ADR-0004 section 5, spec 2.7): the one connection state the engine
// derives, plus what the indicator shows beside it.
//
// States, first match wins:
//   offline              the host called setOffline(true) (the engine cannot know)
//   folder-disconnected  the folder cannot be reached: the root listing at the
//                        start of the last scan failed, or any folder operation
//                        since failed with NotAllowedError or SecurityError,
//                        or creating directly under the root failed with
//                        NotFoundError. Cleared by the next successful root
//                        listing or write. Local changes are still accepted
//                        and stay pending.
//   retrying             the last save attempt failed and a retry is scheduled
//   saving               there are pending updates, or one of our own files
//                        went missing from the folder (or was replaced) and
//                        has not been written again yet (own-repair.js)
//   not-reaching-peers   nothing pending, saves succeed, at least one other
//                        device was active within health.peerActiveWindowMs
//                        (judged by when this device last saw its status file
//                        change, on this device's clock, as deletion does; a
//                        peer never observed counts as active), and every
//                        such active peer has failed to
//                        acknowledge our latest chunk for longer than
//                        health.ackTimeoutMs since we first wrote it. A peer
//                        acknowledges a chunk when its status file lists our
//                        chunk sequence as seen. Only the "chunks" layout
//                        records acknowledgements; the others never report it.
//   saved                otherwise
import { pendingBounds } from "./saver.js";

export const HEALTH_STATES = Object.freeze(["saved", "saving", "retrying", "folder-disconnected", "not-reaching-peers", "offline"]);

/**
 * Does this peer's status show it has seen our latest chunk of every table we
 * wrote since start (and that it also has)? null when that cannot be told.
 * waitingSince: when we first wrote the oldest chunk it has not acknowledged.
 */
function ackState(ctx, meta) {
  const self = ctx.cfg.deviceId;
  let comparable = 0;
  let waitingSince = null;
  for (const [table, w] of Object.entries(ctx.rt.written)) {
    const theirs = meta.tables?.[table];
    if (!theirs) continue; // the peer does not use this table
    comparable += 1;
    if ((theirs.applied?.[self]?.seen ?? 0) < w.seq) waitingSince = waitingSince == null ? w.firstAt : Math.min(waitingSince, w.firstAt);
  }
  if (!comparable) return { acked: null, waitingSince: null };
  return { acked: waitingSince == null, waitingSince };
}

/** Called when a peer's status file was (re)read: remember when it last acknowledged us. */
export function observePeerStatus(ctx, device, meta) {
  if (ackState(ctx, meta).acked === true) ctx.rt.acks = new Map(ctx.rt.acks).set(device, { lastAckedAt: ctx.cfg.clock.now() });
}

export function peerView(ctx) {
  const { rt, cfg } = ctx;
  const now = cfg.clock.now();
  const out = {};
  for (const [device, { meta }] of rt.statuses) {
    const { acked, waitingSince } = ackState(ctx, meta);
    const seen = rt.statusSeen[device]; // when this device saw the status file change, on our clock
    out[device] = {
      user: meta.user,
      lastHeardAt: seen?.at ?? null,
      lastAckedAt: rt.acks.get(device)?.lastAckedAt ?? null,
      active: !seen || now - Math.min(seen.at, now) <= cfg.options.health.peerActiveWindowMs,
      ackedLatest: acked,
      waitingSince,
    };
  }
  return out;
}

function nextSaveAt(ctx) {
  const { rt, cfg } = ctx;
  const { oldestAt, newestAt } = pendingBounds(ctx);
  if (oldestAt == null) return null;
  const o = cfg.options;
  const earliest = rt.retryAt != null ? rt.retryAt : Math.min(newestAt + o.quietMs, oldestAt + o.maxWaitMs);
  return rt.lastSaveAt == null ? earliest : Math.max(earliest, rt.lastSaveAt + o.minIntervalMs);
}

function notReaching(ctx, peers, pending) {
  const { rt, cfg } = ctx;
  if (pending || rt.retryAt != null) return null;
  const active = Object.entries(peers).filter(([, p]) => p.active);
  if (!active.length) return null;
  const now = cfg.clock.now();
  const waits = active.map(([, p]) => (p.ackedLatest === false && p.waitingSince != null ? now - p.waitingSince : null));
  if (waits.some((w) => w == null || w <= cfg.options.health.ackTimeoutMs)) return null;
  return `no active colleague (${active.length}) has acknowledged our changes for over ${Math.floor(Math.min(...waits) / 1000)} s`;
}

export function computeHealth(ctx, { withPeers = false } = {}) {
  const { rt } = ctx;
  const pending = [...ctx.tables.values()].reduce((n, T) => n + T.pending.length, 0);
  const repairing = [...ctx.tables.values()].some((T) => T.idx.repair);
  let peers = null;
  let state = "saved";
  let reaching = null;
  if (rt.offline) {
    state = "offline";
  } else if (rt.folder.fault) {
    state = "folder-disconnected";
  } else if (rt.retryAt != null) {
    state = "retrying";
  } else if (pending || repairing) {
    state = "saving";
  } else {
    peers = peerView(ctx);
    reaching = notReaching(ctx, peers, pending);
    if (reaching) state = "not-reaching-peers";
  }
  if (!withPeers) return { state, detail: null, pending, repairing, peers: null, nextSaveAt: null };
  peers ??= peerView(ctx);
  const next = nextSaveAt(ctx);
  const detail = {
    offline: "the host reports no network",
    "folder-disconnected": `${rt.folder.fault?.name} while using the folder; changes are kept locally`,
    retrying: `saving failed ${rt.failures} time(s); next attempt at ${rt.retryAt}`,
    saving: pending ? `${pending} change(s) waiting; next save due at ${next}` : "writing again files of ours that went missing from the folder",
    "not-reaching-peers": reaching,
    saved: "everything is written to the folder",
  }[state];
  return { state, detail, pending, repairing, peers, nextSaveAt: next };
}

/** Recompute the state; emits "health" when it changed. Returns the full report when asked. */
export function refreshHealth(ctx, { full = false } = {}) {
  const { rt, cfg } = ctx;
  const report = computeHealth(ctx, { withPeers: full });
  if (!rt.health) {
    rt.health = { state: report.state, since: cfg.clock.now() };
  } else if (rt.health.state !== report.state) {
    const previous = rt.health.state;
    rt.health = { state: report.state, since: cfg.clock.now() };
    ctx.emit("health", { state: report.state, previous, since: rt.health.since });
  }
  if (!full) return null;
  return {
    state: report.state,
    since: rt.health.since,
    detail: report.detail,
    lastSaveAt: rt.lastSaveAt,
    lastScanAt: rt.lastScanAt,
    lastScanOkAt: rt.lastScanOkAt,
    pending: report.pending,
    repairing: report.repairing, // an own file is missing from the folder (or was replaced) and not written again yet
    nextSaveAt: report.nextSaveAt,
    retryAt: rt.retryAt,
    peers: report.peers,
  };
}
