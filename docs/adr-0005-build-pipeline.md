# ADR-0005: Build pipeline and loader (Vite, signed bundles)

**Status:** Accepted for the tool choice, the loader pattern and signing (decided 2026-11-21); details below are Proposed until built
**Date:** 2026-11-21
**Deciders:** Harry
**Epic:** EA · EA Workbench
**Related:** ADR-0001 (sync engine), ADR-0003 (admin app, keys), ADR-0006 (plugins)

## Context

Colleagues open the app from a OneDrive folder. A page opened from disk cannot load separate script files, so code has to arrive either inline in the page or read from the folder by the page itself. The source is many small tested modules.

Opening one big HTML file from the synced folder would already give everyone the latest version. It has three weaknesses:

- A half-synced file is a broken app.
- If the folder is unreachable, there is no app.
- Anyone who can write to the folder can replace the file, and so run code in every colleague's browser with access to the workspace key.

The project's filing hook accepts HTML source only under `masters/` or an epic folder.

## Decision

Build with **Vite**. Ship a **tiny bootstrap page** that loads the **real app as a signed bundle** from the shared folder and runs it from a Blob URL.

### 1. Outputs

| Output | Built as | Changes |
|---|---|---|
| `<id>.html` (bootstrap) | Single HTML file (`vite-plugin-singlefile`), holding only the loader and the public signing key | Rarely. Updating it is the one thing that needs manual redistribution. |
| `<id>-<version>.js` (app bundle) | One ES module, styles included | Every release |
| `admin.html` (admin app) | Single HTML file, standalone, not loaded through the loader | Every release. It must work when everything else is broken. |

Everything is bundled; nothing is fetched from the network at run time. No WebAssembly dependencies. Size budget: bootstrap under 50 KB, app bundle under 500 KB (engine with Yjs is 110 KB today).

### 2. Folder layout

`<id>` and `<name>` are the app's id and name from `app/app.config.ts`; for the example app, `trellis-example` and `Trellis Example`.

```
<name>/
  <id>.html
  app/
    manifest.json
    <id>-1.4.0.js
    <id>-1.3.2.js
  plugins/
  data/  status/  backups/
```

- **`backups/`** holds one folder per backup, `backups/<UTC stamp>/<table>.ywb`, written only by the admin page's "Back up now" (ADR-0001 section 8). "Download backup" gives the same folder as one zip, `backup-<stamp>.zip`, to keep away from the shared folder; the admin page restores it into an empty folder together with the key backup.
- **Bundles are write-once**, with the version in the file name. They are never rewritten.
- **`manifest.json` is the only file that changes.** It is one file holding a body and a signature over that body, so the two can never be out of step.

### 3. Manifest

The body lists:

- a **serial number** that only ever increases;
- the **current version** per channel (for example `stable`, `beta`);
- for each bundle: file name, SHA-256 hash, and the minimum bootstrap version it needs;
- the installed plugins (ADR-0006), each with its hash.

One signature therefore covers the app and every plugin.

### 4. Signing

- The admin holds an ECDSA P-256 private key. The matching public key is built into the bootstrap.
- The admin app signs the manifest when publishing a release.
- The loader runs a bundle only if the manifest's signature verifies and the bundle's hash matches the manifest.
- The loader refuses a manifest whose serial is lower than the last one it accepted, so an old signed manifest cannot be replayed to force a downgrade. A deliberate rollback is a new manifest, with a higher serial, pointing at an older bundle.
- Bundles are signed, not encrypted. The code is not secret.

### 5. Boot sequence

1. The bootstrap looks in browser storage for the last bundle it verified.
2. **If there is one, it runs immediately.** The app is usable before the folder is connected.
3. Once the folder is connected, the loader reads the manifest, verifies it, and if the version differs reads and verifies the new bundle, stores it, and tells the user a new version is ready to load.
4. **If there is no cached bundle** (first run, or cleared storage), the bootstrap shows a connect-folder screen, then does step 3 and runs the result.
5. A bundle or manifest that fails verification is ignored and reported; the cached version keeps running.

The loader keeps the two most recent verified bundles. Opening the page with `#previous` runs the older one; `#safe` runs the current one with no plugins.

### 6. Loader contract

As built (contract 1, `framework/runtime/loader/contract.ts`): the bundle exports `start(services)`. The services are the bundle's version, the bootstrap version, the `#safe` flag, the element to render into, and `checkForUpdate(folder)`. The app calls `checkForUpdate` once its folder is connected; the bootstrap then re-checks every 15 minutes and shows a note when a version is ready or was refused. An optional `onUpdate(listener)` service (added 2026-11-21, OUT-37, approved by Harry) lets the running app hear each check's result and returns an unsubscribe function. While anything is subscribed the bootstrap draws no note, so the shell's update notice shows it in the app's design and wording; a subscriber that arrives after a check hears its result and the bootstrap's note is taken down. With no subscriber the bootstrap draws its own note as before, so an app that fails before it mounts is still told. The contract number and `BOOTSTRAP_VERSION` stay at 1 because no bootstrap had been handed out. The manifest file is `{ "body": "<JSON text>", "signature": "<base64>" }`, signed over the exact body text. The public key reaches the bootstrap at build time from `TRELLIS_PUBLIC_KEY` or `app/signing-public-key.json`; the build fails without one.

The bundle exports one entry function, called with the loader's services (folder connection, cache, update check, bootstrap version). The contract has a version number; the manifest states the minimum bootstrap each bundle needs, and the loader refuses a bundle it is too old for with a clear message.

### 7. Source layout and development

| Path | Role |
|---|---|
| `framework/engine/` | Engine, record layer, simulator and tests. Plain ES modules, no build step. |
| `framework/runtime/` | Host, loader, bootstrap, the app definition types and the derived names (`names.ts`), and their tests. |
| `framework/build/` | Vite configuration, release, smoke test and key generation scripts. |
| `app/` | The app: `app.config.ts`, the one place its id, name and tables are declared, and its source in `app/src/`. Imports only `@trellis/framework`. |
| `masters/` | The HTML entry pages Vite builds from: `bootstrap.html` and `dev.html`. |

One npm workspace root holds `framework` and `app`, with one lockfile; every command runs from the root.

`npm run dev` serves the app directly from `localhost` (`masters/dev.html`), without the loader, for quick iteration. A page on `localhost` does not behave exactly like one opened from disk, so behaviour is judged on the built files.

### 8. Release ("minting")

1. Run the engine tests and simulation batches.
2. Bump the version and build.
3. Smoke-test from disk in headless Chrome: the bootstrap loads the new bundle from a test folder and the app starts.
4. In the admin app, publish: copy the bundle into `app/`, then write the new signed manifest.
5. Colleagues receive it on their next update check.

### 9. Release pipeline as built (2026-11-21)

Until the admin app exists, a release is produced by GitHub Actions, not by the admin app:

- **CI** (`.github/workflows/ci.yml`): on every pull request and push to `main`, runs `npm ci`, `npm test` (engine and runtime tests), `npm run typecheck` and `npm run build:app` from the root.
- **Release** (`.github/workflows/release.yml`): pushing a tag such as `v1.2.0` runs the tests and the from-disk smoke test, builds the bootstrap and the bundle at that version, signs the manifest, and publishes a GitHub Release holding `<id>-1.2.0.zip`. The zip is the `<name>/` folder of section 2, ready to copy into the shared folder. `framework/build/release.js` writes the folder, zip name and release title to the workflow's outputs, so the workflow holds no app name.
- **Keys:** `npm run keygen` (`framework/build/keygen.js`) prints a key pair. The public key is the repository variable `TRELLIS_PUBLIC_KEY`; the private key is the repository secret `TRELLIS_SIGNING_KEY`. This departs from section 4: GitHub, not only the admin, holds the signing key.
- **Serial:** the build time in seconds, and always at least one above the previous manifest's.
- **History:** the release also publishes `manifest.json` as its own asset. The next release downloads it from the latest GitHub Release (`gh release download`) and passes it to `release.js --previous`, which verifies its signature with the public key and lists its bundles again in the new manifest. A previous manifest that fails verification stops the release; no latest release means the first release. A version already listed with a different hash is refused, since bundles are write-once. The zip holds only the new bundle: earlier ones are already in the shared folder, because a release is copied over it. A fresh folder that lacks an old bundle is safe, since the loader only reads the bundle a channel points at. The manifest stays format 1 with no new field.
- **Rollback:** `npm run release -- --rollback <version> --previous <manifest.json>` builds nothing. It signs a manifest with a new serial pointing `stable` at a version the previous manifest lists, refuses one it does not, and writes only `<name>/app/manifest.json` to copy into the shared folder. It runs where the signing key is, so today on the admin's machine with the two key variables set; it is not published as a GitHub Release, and the next release still lists every bundle because it builds on the last published manifest.
- **Limits:** a rollback made locally is not recorded on GitHub, so the next tagged release takes its serial from the clock and its history from the last published manifest.

## Options Considered

| Option | Complexity | Drawback |
|---|---|---|
| **A. Vite; bootstrap plus signed bundle (chosen)** | Medium | A loader to build and keep stable; a signing key to look after |
| B. Vite; one single-file app, replaced in the folder | Low | Half-synced file breaks the app; no offline start; no protection against replaced code |
| C. Loader without signing | Low to medium | Any writer to the folder runs code for everyone |
| D. Libraries from a CDN | Low | Fails offline or where blocked |

## Consequences

**Easier**

- Updates reach everyone without redistributing a file.
- A partly synced release is never run.
- The app starts without the folder.
- Rollback and staged rollout are a manifest change.
- Only code the admin signed runs.

**Harder**

- **The signing key is a single point of failure.** Lost, no release can be published until a new bootstrap is handed out. Leaked, its holder can ship code to everyone. It needs a passphrase-protected backup.
- The bootstrap must stay small and stable; mistakes in it are the expensive ones.
- On a page opened from disk, other local HTML files may share browser storage, including the admin's signing key and the cached bundle.
- Debugging a Blob-loaded bundle is slightly less convenient.

**Verified (development machine, headless Chrome, page opened from disk)**

- A minted single-file page loads and runs; it is a secure context with folder access, Web Crypto and IndexedDB present.
- A module can be run from a Blob URL.
- SHA-256 hashing and ECDSA signature verification work.

- The built bootstrap, opened from disk, verifies a signed manifest and bundle, caches the bundle in IndexedDB, runs it from a Blob URL, starts from the cache on reload, and refuses a manifest signed with another key (`npm run smoke`). Sizes: bootstrap 9 KB, app bundle 405 KB.

**Not yet verified**

- Reading a bundle through a real folder handle from a page opened from disk. Headless Chrome cannot drive the folder picker and does not offer its private file area to pages opened from disk, so the smoke test uses an in-page stand-in folder.
- Any of this on the work laptops, under their browser policies.

## Action Items

1. [x] Build the bootstrap and loader, with tests for every verification failure path (`framework/runtime/loader/`, `framework/runtime/bootstrap/`, `framework/runtime/test/loader.test.js`).
2. [ ] Add the three Vite build targets. Done: `bootstrap` and `app` (`npm run build`). The `admin` target waits for the admin app (item 3).
3. [ ] Add key generation, backup and "publish release" to the admin app.
4. [x] Script the from-disk smoke test so a failed check fails the release (`npm run smoke`).
5. [x] Remove Automerge from the code and dependencies.
6. [ ] Try the bootstrap and a bundle on a work laptop.
