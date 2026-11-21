// Shared names, patterns and option defaults for the engine (ADR-0001, ADR-0004).

export const MAGIC = Uint8Array.of(0x45, 0x41, 0x57, 0x31); // "EAW1"
export const HEADER_BYTES = 17; // magic(4) + keyId(1) + iv(12)
export const IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;

// ADR-0001 section 7. A conflict-copy suffix (-DEVICE) is allowed on both.
export const CHUNK_RE = /^(\d{6})(-.+)?\.ywb$/;
export const SNAP_RE = /^snap-(\d{8}T\d{6}Z)(-.+)?\.ywb$/;
export const LAYOUTS = Object.freeze(["chunks"]);
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/; // table and device names

// Highest chunk number the 6-digit file-name rule can express.
export const MAX_CHUNK_SEQ = 999999;

export const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_OPTIONS = Object.freeze({
  layout: "chunks",
  chunkContent: "merged",
  sealBytes: 65536,
  newChunkPerSession: true,
  quietMs: 30000,
  maxWaitMs: 180000,
  minIntervalMs: 30000,
  scanMs: 30000,
  statusMs: 60000,
  ownCheckMs: 600000, // how often our own sealed chunks are checked against the folder, and the least time between two repairs
  appVersion: "dev",
  schemaVersions: Object.freeze({}),
  retryInitialMs: 5000,
  retryMaxMs: 300000,
  maxErrors: 50,
  localSnapshotEvery: 100,
  // Tracing and health (ADR-0004). trace.level: "off" | "summary" | "full".
  trace: Object.freeze({ level: "full", memoryLimit: 500, storeLimit: 200, persistBatch: 10 }),
  health: Object.freeze({ peerActiveWindowMs: 15 * 60 * 1000, ackTimeoutMs: 10 * 60 * 1000 }),
  compaction: Object.freeze({
    enabled: true,
    chunkThreshold: 50,
    snapshotMaxAgeMs: 7 * DAY_MS,
    minSnapshotAgeMs: DAY_MS,
    activeWindowMs: 30 * DAY_MS,
    ackRule: "all-active",
    jitterMs: 10000,
  }),
});
