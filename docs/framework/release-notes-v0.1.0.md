Trellis v0.1.0 is the first release: a starting point for small team apps that run from a shared folder with no server. This release holds the example app, ready to copy into the shared folder.

## What is in the zip

The app's release folder, laid out like the shared folder (ADR-0005 section 2): the bootstrap page, the admin page, the app bundle and the signed `manifest.json`. Unzip it and copy the folder's contents over the shared folder. `manifest.json` is also published on its own so the next release can list this one's bundle.

## Gates passed

Every gate in [`docs/framework/README.md`](https://github.com/harry-burton-dev/single-file-web-apps/blob/main/docs/framework/README.md) section 3. G1 to G11 run in `npm run rubric` in CI on the tagged commit. G12 and G13 are decided outside the author:

| Gate | What passed |
|---|---|
| G1 New project | `npm run create -- demo-app` makes a project that installs, typechecks, tests and builds (CI `template` job) |
| G2 No leftover names | A created project names "trellis" only in the allowed list |
| G3 One definition file | Names follow `app/app.config.ts` |
| G4 No business logic | Framework folders hold no app's table or field names |
| G5 Screens never touch the engine | App code imports only `@trellis/framework` |
| G6 Real keys | Invited users read each other's data, an outsider cannot; no fixed key in the build |
| G7 Two users converge | Two browser contexts on one folder, from built files on disk |
| G8 Signed update end to end | N+1 offered and loaded, a forged N+2 refused |
| G9 Survives loss | Backup and restore; a newer schema is refused, not corrupted |
| G10 Engine faults closed | All probes pass |
| G11 Size budgets | Bootstrap under 50 KB, app bundle under 500 KB |
| G12 Cold start | A fresh agent with only the quickstart added a table and a screen that syncs. Record: [cold-start-v0.1.0.md](https://github.com/harry-burton-dev/single-file-web-apps/blob/main/docs/framework/cold-start-v0.1.0.md) |
| G13 Tag makes a release | This release is built and signed by GitHub's runner. Its zip is then downloaded, unzipped and run through the two-user test; the result is ticked in the README |

The release is rehearsed first as the pre-release `v0.1.0-rc.1`, whose zip goes through the same test; the `v0.1.0` manifest lists that bundle as history.

## Known limits

- No proof on real OneDrive or on a work laptop. The tests use a local stand-in folder, which does not reproduce a sync client's delays, conflict copies or placeholders.
- No plugins.
- The signing key is held in GitHub (the `TRELLIS_SIGNING_KEY` secret), not only by the admin. A rollback is signed on the admin's machine and is not recorded on GitHub.
- Framework upgrades are manual: copy the framework folders into your project.
- A typed number field cannot be cleared once it has a value, because a command refuses an empty value. Screens ignore blank input.
