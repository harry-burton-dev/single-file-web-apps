# npm scripts

Run every script from the project's root folder.

## Everyday

| Script | What it does |
|---|---|
| `npm run dev` | Serves the app from `localhost` and opens it. It runs your screens directly, without the page that loads releases. |
| `npm run typecheck` | Checks types in `framework/` and `app/`. |
| `npm test` | Runs every test, including the docs checks and the app import rule. |
| `npm run build` | Builds the page, the app and the admin page into `dist/`, then checks the [size budgets](../explanation/size-budgets.md). |
| `npm run ci` | Installs from the lockfile, then runs `typecheck`, `test` and `build`. It is what the CI workflow runs. |

`npm run build` and `npm run ci` need the public signing key. Set `TRELLIS_PUBLIC_KEY`, or add `app/signing-public-key.json`.

## Releasing

| Script | What it does |
|---|---|
| `npm run keygen` | Prints a new signing key pair, as two lines. Run it once per app. |
| `npm run release` | Builds and signs a release into `dist/release/`. It needs both keys. |
| `npm run release -- --previous <manifest.json>` | The same, and lists the earlier versions from that manifest again. |
| `npm run release -- --rollback <version> --previous <manifest.json>` | Builds nothing. Writes a signed manifest that points back at `<version>`. |
| `npm run release -- --out <folder>` | Writes the release folder under `<folder>` and not `dist/release`. |

[Cut a signed release](../guides/release.md) and [Roll back a release](../guides/roll-back.md) show them in use.

## Checks

| Script | What it does | Needs |
|---|---|---|
| `npm run size` | Reports the size of the page and the app file against their budgets. | A build |
| `npm run rubric` | Runs each release gate and prints a table of pass and fail. | A build, and Playwright for three gates |
| `npm run smoke` | Opens the built files from disk in a headless browser: load, update, refuse a forged update, back up and restore. | Playwright |
| `npm run two-users` | Runs two browser contexts on one folder from the built files, and checks that they end with the same data. | A build and Playwright |
| `npm run probes` | Runs the sync engine's fault tests. | |
| `npm run check:no-test-key` | Fails if the build holds a fixed test key. | A build |
| `npm run test:shell` | Runs only the shell's component tests. `npm test` includes them. | |

Playwright is not a dependency of the project. The CI workflow installs it before the steps that need it:

```sh
npm install --no-save playwright
npx playwright install --with-deps chromium
```

`npm run size` prints one line for each budget:

```text
Size budgets (uncompressed, must be under the limit):
  bootstrap 9,548 bytes of 50,000, 40,452 bytes headroom
  bundle    466,442 bytes of 500,000, 33,558 bytes headroom
```

## Only in the framework's own repository

| Script | What it does |
|---|---|
| `npm run create -- <name>` | Makes a new project beside this folder. `--dir <folder>` puts it elsewhere. |

A created project does not have this script. A project is made from the framework's repository, not from another project.
