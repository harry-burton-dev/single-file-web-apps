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
| App name | Hard-coded in 16 source files | database name, lock name, picker id, `WORKBENCH_*` variables, page titles |
| Packaging | App imports the engine by relative path | `workbench/src/host/host.ts` lines 5-6 |
| Keys | One fixed test key, key id 0 | `workbench/src/app/test-key.ts` |
| Identity | A typed name | `workbench/src/app/app.tsx` |
| App | An engine test page with one shared note | `workbench/src/app/app.tsx` |
| Schema versions | Stored per device and read; no migration path | `sync-engine/src/records/keys.js`, `table.js` |
| Backups | Folder named in ADR-0005; nothing writes it | no match for "backups" in source |
| Open engine faults | 3 probes fail | `npm run probes`: P14a, P14b, P15 |

## 3. Rubric: what "bootstrap state" means

Each gate is pass or fail and is checked by a command, not by opinion. v0.1.0 ships only when every gate passes in CI. Epic S6 builds `npm run rubric`, which runs them all and prints this table.

| Gate | Requirement | Check |
|---|---|---|
| G1 New project | `npm run create -- <name>` in a clean clone produces a project that installs, typechecks, tests and builds with no manual edit | CI job creates a project named `demo-app` and runs its full CI in it |
| G2 No leftover names | The created project contains neither "workbench" nor "trellis" outside `node_modules`, the lockfile and a single attribution line | `grep -ri` in the created project returns only the allowed lines |
| G3 One definition file | App name, id, tables and field rules are declared only in `app/app.config.ts` | Changing the name there changes the page title, database name, lock name and release file names; test asserts all four |
| G4 No business logic | Framework folders hold no table or field name of any app | A test loads the framework with an empty app definition and starts; grep finds no example-app identifiers in framework folders |
| G5 Screens never touch the engine | App code imports only from the framework's public entry | Lint rule or test fails on any import from engine, loader or host internals in `app/` |
| G6 Real keys | No fixed key in the build; data written by one invited user is readable by another and unreadable without an invite | Automated test with two users and one outsider |
| G7 Two users converge | Two browser contexts on one folder, both edit, both end with the same data | Headless test using the example app, from built files opened from disk |
| G8 Signed update end to end | Version N running; release N+1 placed in the folder; app offers it, loads it; a forged N+2 is refused | Extends the existing smoke test |
| G9 Survives loss | Backup then restore into an empty folder reproduces all data; a newer-schema table opened by an older app is refused with a message, not corrupted | Automated tests |
| G10 Engine faults closed | P14a, P14b and P15 pass and all probes run in CI | `npm run probes` exit 0 in CI |
| G11 Size budgets | Bootstrap under 50 KB; framework plus example app bundle under 500 KB | Build step fails over budget |
| G12 Cold start | A fresh agent given only `docs/quickstart.md` and the created project adds a second table and a screen that syncs, without editing framework folders | Run once before release; transcript and diff recorded in the release notes |
| G13 Tag makes a release | Pushing `v0.1.0` publishes the zip, and unzipped into a folder it passes G7 | The release workflow run itself |

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

Order: S1 first. S2, S3 and the engine half of S5 can run side by side. S4 next. S6 last.

## 5. Rules for running this unattended

- One pull request per epic, opened as a draft, named `TRELLIS · S<n> · <summary>`. Do not merge; Harry merges.
- Tests are written first and seen to fail. A gate is never met by skipping, deleting or weakening a test.
- No long simulation runs. The short sanity run (5 seeds, two fault profiles) is the limit unless a change touches engine save, scan or compaction logic, in which case 30 seeds of `short` under `rough` and `hostile`.
- Every decision listed under "Defaults chosen" in a spec is taken as written. Anything not covered that changes file formats, key handling or the loader contract stops the epic and is reported, with a recommendation.
- File formats already in use (chunk envelope, manifest, status files) do not change in v0.1.0.
- Each epic ends by updating the ADR it implements and ticking its gates in this file.
