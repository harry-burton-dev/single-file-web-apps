// The loader (ADR-0005 section 5): which bundle to run, and how a new one is
// accepted. Nothing here touches the page: the folder handle, the cache (a
// key/value store) and Web Crypto are passed in.
//
// Cache keys:
//   loader/state            { serial, bundles: [{ version, sha256 }] }, newest first, at most two
//   loader/bundle/<version> the verified bundle's bytes
import { LoaderError, sha256Hex, verifyManifest } from "./manifest.js";

const STATE_KEY = "loader/state";
const KEEP = 2;
const bundleKey = (version) => `loader/bundle/${version}`;

export async function readState(cache) {
  const state = await cache.get(STATE_KEY);
  return { serial: state?.serial ?? 0, bundles: state?.bundles ?? [] };
}

/** The verified bundle to run now: the current one, or the one before it (#previous). Null when there is none. */
export async function cachedBundle(cache, { previous = false } = {}) {
  const entry = (await readState(cache)).bundles[previous ? 1 : 0];
  if (!entry) return null;
  const bytes = await cache.get(bundleKey(entry.version));
  return bytes ? { version: entry.version, bytes } : null;
}

async function readFolderFile(root, name, missingCode, missingMessage) {
  try {
    const dir = await root.getDirectoryHandle("app");
    const file = await (await dir.getFileHandle(name)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    if (err?.name === "NotFoundError") throw new LoaderError(missingCode, missingMessage);
    throw new LoaderError("folder-unreadable", `The shared folder could not be read (${err?.name ?? "error"}).`);
  }
}

async function accept(input) {
  const { root, cache, publicKey, subtle, channel = "stable", bootstrapVersion } = input;
  const text = new TextDecoder().decode(await readFolderFile(root, "manifest.json", "manifest-missing", "This folder has no release manifest (app/manifest.json)."));
  const body = await verifyManifest({ text, publicKey, subtle });
  const state = await readState(cache);
  if (body.serial < state.serial) {
    throw new LoaderError("serial-replayed", `The release manifest (serial ${body.serial}) is older than one already accepted (serial ${state.serial}). It was ignored.`);
  }
  // remembered at once: a manifest whose bundle has not arrived yet still rules out every older manifest
  if (body.serial > state.serial) await cache.set(STATE_KEY, { ...state, serial: body.serial });
  const version = body.channels[channel];
  if (!version) throw new LoaderError("channel-unknown", `The release manifest has no "${channel}" channel.`);
  const listed = body.bundles[version];
  if (!listed) throw new LoaderError("bundle-unlisted", `The release manifest names version ${version} but does not describe it.`);
  if (listed.minBootstrap > bootstrapVersion) {
    throw new LoaderError("bootstrap-too-old", `Version ${version} needs a newer bootstrap page. Ask the admin for the current one.`);
  }
  const at = state.bundles.findIndex((b) => b.version === version && b.sha256 === listed.sha256);
  if (at === 0) return { status: "current", version };
  if (at < 0) {
    const bytes = await readFolderFile(root, listed.file, "bundle-missing", `Version ${version} has not arrived in the folder yet (${listed.file}).`);
    if ((await sha256Hex(bytes, subtle)) !== listed.sha256) {
      throw new LoaderError("bundle-hash-mismatch", `Version ${version} in the folder does not match the release manifest. It may still be syncing.`);
    }
    await cache.set(bundleKey(version), bytes);
  }
  const entry = { version, sha256: listed.sha256 };
  const bundles = [entry, ...state.bundles.filter((b) => b.version !== version)];
  await cache.set(STATE_KEY, { serial: body.serial, bundles: bundles.slice(0, KEEP) });
  for (const dropped of bundles.slice(KEEP)) await cache.delete(bundleKey(dropped.version));
  return { status: "updated", version };
}

/**
 * Read the folder's manifest and, if it names a version other than the cached
 * one, verify and cache that bundle. Never throws:
 *   { status: "current", version }   nothing new
 *   { status: "updated", version }   a new verified bundle is cached; it runs on the next load
 *   { status: "rejected", code, message }   ignored; whatever is cached stays
 */
export async function checkForUpdate(input) {
  try {
    return await accept(input);
  } catch (err) {
    if (err instanceof LoaderError) return { status: "rejected", code: err.code, message: err.message };
    return { status: "rejected", code: "unexpected", message: `The update check failed (${err?.name ?? "error"}: ${err?.message ?? err}).` };
  }
}
