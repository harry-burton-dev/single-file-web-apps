// The body of a release manifest, built from the one before it (ADR-0005
// section 9). A release keeps every bundle the previous manifest listed, so a
// rollback is only a new signed manifest pointing stable at one of them.
// The caller verifies the previous manifest's signature before passing it in.
import { validateBody } from "../runtime/loader/manifest.js";

/** Build time in seconds, and always above the previous serial so the loader accepts it. */
const nextSerial = (previous, now) => Math.max(Math.floor(now / 1000), (previous?.serial ?? 0) + 1);

/** A new release of `version`: the previous bundles plus this one, with stable pointing at it. */
export function releaseBody({ previous, version, file, sha256, now }) {
  const listed = previous?.bundles[version];
  if (listed && listed.sha256 !== sha256) {
    throw new Error(`Version ${version} was already released with a different bundle. Bundles are write-once: bump the version in app/package.json.`);
  }
  return validateBody({
    format: 1,
    serial: nextSerial(previous, now),
    channels: { ...previous?.channels, stable: version },
    bundles: { ...previous?.bundles, [version]: { file, sha256, minBootstrap: 1 } },
  });
}

/** The previous manifest with stable pointing back at `version`, which it must already list. */
export function rollbackBody({ previous, version, now }) {
  if (!previous.bundles[version]) {
    throw new Error(`Version ${version} is not listed in the previous manifest. Listed: ${Object.keys(previous.bundles).join(", ")}.`);
  }
  return validateBody({ ...previous, serial: nextSerial(previous, now), channels: { ...previous.channels, stable: version } });
}
