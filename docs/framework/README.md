# Trellis: framework plan for the first release (v0.1.0)

**Status:** Accepted, 2026-11-21. The framework is named Trellis (chosen by Harry; replaces "Workbench").

Trellis is a starting point for small team apps that run from a shared folder with no server. A new project copies this repository, describes its tables, and writes screens. Everything else is already done: sync, encryption, identity, signed updates, the app shell, tests and release.

## 1. Desired state

A developer (or an agent) can do this, and nothing more, to get a working app:

1. Run one command to create a project from Trellis with a new name.
2. Edit one file to declare the app's tables and field rules.
3. Write React screens that read with hooks and write with commands.
4. Push a tag to get a signed release zip to copy into the shared folder.

They never edit engine, loader, host, identity or release code, and no business logic lives in the framework.

## 2. Where the repository is today (audit of the code, 2026-11-21)

| Area | State | Evidence |
|---|---|---|
| Sync engine | Built, 281 unit tests | `sync-engine/src/engine` |
| Record layer (tables, field rules) | Built, **not used by the app** | `sync-engine/src/records`; no import of it under `workbench/src` |
| Host, loader, bootstrap | Built | `workbench/src/host`, `loader`, `bootstrap` |
| CI and tag release | Built; release workflow never run | `.github/workflows` |
| App name | Declared once, in `app/app.config.ts` (S1); database name, lock name, picker id, page title, bundle, release folder and zip names derive from its id and name | `framework/runtime/names.ts`; key variables are `TRELLIS_*`; `framework/test/no-old-name.test.js` |
| Packaging | npm workspaces `framework` and `app` with one lockfile (S1); the app imports only `@trellis/framework` | root `package.json`; `framework/index.ts` |
| Keys | Workspace keyring from the admin page; users enrol from an invite and unlock a passport at each launch (TR3) | `framework/runtime/identity/`; `framework/runtime/admin/` |
| Identity | From the invite, kept in the user's passport; `users` is a framework table (TR3) | `framework/runtime/identity/passport.js`, `admin.js` |
| App shell | `<TrellisApp>` owns invite, choose or reconnect the folder, "already open", then the app's screens; health indicator, diagnostics menu, reconnect banner, update notice, conflict prompt and error screen are always available; all wording in one strings file, colours only from the project's tokens (S4) | `framework/runtime/shell/`; `npm run test:shell` |
| App | The example app: one `items` table and one screen, 80 of 150 lines; with no tables and no screens the project still builds and shows the empty shell (S4) | `app/`; `framework/test/app-size.test.js`, `framework/runtime/shell/test/empty-app-build.test.ts` |
| Sizes | Bootstrap 9,535 of 50,000 bytes, bundle 466,580 of 500,000; the build fails over budget (S4) | `framework/build/size-budget.js` in `npm run build` |
| Schema versions | Each table's version and migrations are declared in `app/app.config.ts`; migrations run per record as it is read and written back by command; an older app refuses to write a table stored at a higher version and says so, and other tables keep working (S5) | `framework/engine/src/records/table.js`, `framework/data/registry.ts`; `framework/engine/test/records/versions.test.js`, `framework/data/test/migrations.test.js` |
| Backups | The admin page backs up every table to `backups/<stamp>/`, downloads it as one zip, and restores that zip with the key backup into an empty folder (S5) | `framework/runtime/backup/`, `framework/runtime/admin/`; `framework/runtime/test/backup/`, step 6 of `npm run smoke` |
| Open engine faults | None; all 29 probes pass and run in CI (S5) | `npm run probes` in `.github/workflows/ci.yml` and `release.yml` |

## 3. Rubric: what "bootstrap state" means

Each gate is pass or fail and is checked by a command, not by opinion. v0.1.0 ships only when every gate passes in CI. Epic S6 builds `npm run rubric`, which runs them all and prints this table.

| Gate | Requirement | Check |
|---|---|---|
| G1 New project **(passed, S6)** | `npm run create -- <name>` in a clean clone produces a project that installs, typechecks, tests and builds with no manual edit | CI job creates a project named `demo-app` and runs its full CI in it. Passed: the `template` job in `.github/workflows/ci.yml`, and `framework/build/test/create.test.js` in `npm run rubric` |
| G2 No leftover names **(passed, S6)** | The created project contains "workbench" nowhere. "trellis" appears only in `node_modules`, the lockfile, the single attribution line in `README.md`, and the framework identifiers `@trellis/framework`, `TRELLIS_PUBLIC_KEY`, `TRELLIS_SIGNING_KEY` and `TrellisApp` (Harry, 2026-11-21) | `framework/build/test/create-names.test.js` scans the created project, file names included, and returns only the allowed lines. Passed in `npm run rubric` |
| G3 One definition file **(passed, S1)** | App name, id, tables and field rules are declared only in `app/app.config.ts` | Changing the name there changes the page title, database name, lock name and release file names; test asserts all four |
| G4 No business logic **(passed, S1)** | Framework folders hold no table or field name of any app | A test loads the framework with an empty app definition and starts; grep finds no example-app identifiers in framework folders |
| G5 Screens never touch the engine **(passed, S2)** | App code imports only from the framework's public entry | Lint rule or test fails on any import from engine, loader or host internals in `app/`. Passed: `framework/test/boundary.test.js` in `npm test`; the public entry no longer exports the engine, `startHost` or `SharedMap` |
| G6 Real keys **(passed, S3)** | No fixed key in the build; data written by one invited user is readable by another and unreadable without an invite | Automated test with two users and one outsider. **Passed** (TR3): `framework/runtime/test/identity/g6.test.js`, `npm run check:no-test-key` in CI |
| G7 Two users converge **(passed, S4)** | Two browser contexts on one folder, both edit, both end with the same data | Headless test using the example app, from built files opened from disk. Passed: `npm run two-users` (`framework/build/test/two-users.js`) in CI; a concurrent `owner` edit raises the conflict prompt on both pages |
| G8 Signed update end to end **(passed, S6)** | Version N running; release N+1 placed in the folder; app offers it, loads it; a forged N+2 is refused | Extends the existing smoke test. Passed: `npm run smoke` places N+1 and a forged N+2 in the stand-in folder while N runs and calls `checkForUpdate` |
| G9 Survives loss **(passed, S5)** | Backup then restore into an empty folder reproduces all data; a newer-schema table opened by an older app is refused with a message, not corrupted | Automated tests. Passed: `framework/runtime/test/backup/backup.test.js` (byte-equal JSON after restore), `framework/data/test/migrations.test.js` (older app refused), and step 6 of `npm run smoke` from built files opened from disk |
| G10 Engine faults closed **(passed, S5)** | P14a, P14b and P15 pass and all probes run in CI | `npm run probes` exit 0 in CI |
| G11 Size budgets **(passed, S4)** | Bootstrap under 50 KB; framework plus example app bundle under 500 KB | Build step fails over budget. Passed: `npm run size` at the end of `npm run build` in CI; `framework/test/size-budget.test.js` proves it fails over budget |
| G12 Cold start **(passed, S6)** | A fresh agent given only `docs/quickstart.md` and the created project adds a second table and a screen that syncs, without editing framework folders | Run once before release; transcript and diff recorded in the release notes. Passed on run 3 of 3: [cold-start-v0.1.0.md](cold-start-v0.1.0.md) |
| G13 Tag makes a release **(passed, S6)** | Pushing `v0.1.0` publishes the zip, and unzipped into a folder it passes G7 | The release workflow run itself. Passed 2026-11-22: [v0.1.0](https://github.com/harry-burton-dev/single-file-web-apps/releases/tag/v0.1.0) built by [run 45079272232](https://github.com/harry-burton-dev/single-file-web-apps/actions/runs/45079272232); its zip, downloaded and unzipped, passed `npm run two-users -- --release <folder>`. Rehearsed first as the pre-release `v0.1.0-rc.1` |

G12 and G13 are the two checks that neither the author nor the plan can mark as passed: one is a third party following the docs, the other is GitHub's runner.

Not in the rubric for v0.1.0: plugins (ADR-0006), a second release channel, and proof on a work laptop against real OneDrive. The last is a known limit and is listed in the release notes.

## 4. Epics

| Epic | Delivers | Gates | Depends on |
|---|---|---|---|
| [S1 Kernel and naming](s1-kernel-and-naming.md) | One repository layout, one app definition file, no hard-coded names | G3, G4 | none |
| [S2 Data access](s2-data-access.md) | Table registry, commands, query hooks, conflict prompts | G5 | S1 |
| [S3 Identity, keys and admin](s3-identity-keys-admin.md) | Workspace key, invites, admin page, admin build target | G6 | S1 |
| [S4 App shell and example app](s4-shell-and-example.md) | First-run flow, health, errors, diagnostics; a one-table example | G7, G11 | S2, S3 |
| [S5 Durability](s5-durability.md) | Engine faults closed, schema versions, backup and restore | G9, G10 | S1 (engine part: none) |
| [S6 New project and release](s6-new-project-and-release.md) | `create` command, rubric runner, quickstart, release v0.1.0 | G1, G2, G8, G12, G13 | all |

In Linear the epics are projects TR1 to TR6 (S1 is TR1, and so on) in the Outer-Pale team.

Order: S1 first. S2, S3 and the engine half of S5 can run side by side. S4 next. S6 last.

## 5. Rules for running this unattended

- One pull request per Linear issue, opened as a draft straight to `main` (no epic branches), named `TRELLIS · S<n> · <summary>`. Do not merge; Harry merges each one.
- Tests are written first and seen to fail. A gate is never met by skipping, deleting or weakening a test.
- No long simulation runs. The short sanity run (5 seeds, two fault profiles) is the limit unless a change touches engine save, scan or compaction logic, in which case 30 seeds of `short` under `rough` and `hostile`.
- Every decision listed under "Defaults chosen" in a spec is taken as written. Anything not covered that changes file formats, key handling or the loader contract stops the epic and is reported, with a recommendation.
- File formats already in use (chunk envelope, manifest, status files) do not change in v0.1.0.
- Each epic ends by updating the ADR it implements and ticking its gates in this file.
