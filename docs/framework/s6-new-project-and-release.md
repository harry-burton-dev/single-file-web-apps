# S6: New project and release

**Goal:** one command starts a project, one tag ships it, and the rubric proves both. Ends with the tag `v0.1.0`.

## Start from

- `.github/workflows/ci.yml`, `release.yml`, `scripts/release.js`, `keygen.js`, `smoke.js`.
- The rubric in `README.md` section 3.
- The finished example app from S4.

## Deliver

1. **`npm run create -- <name>`**: copies the repository to a sibling folder, sets `id` and `name` in `app/app.config.ts` and the package names, resets the version to 0.1.0, removes framework-only docs and history, and runs install, tests and build to prove the result. Refuses an invalid name or an existing folder.
2. **`npm run rubric`**: runs gates G1 to G11 and prints the table with pass or fail and the command that decided each. Non-zero exit on any fail. CI runs it on every pull request.
3. **Template acceptance job** in CI: creates `demo-app` with the command above in a temporary folder and runs that project's own CI inside it (gates G1, G2).
4. **Smoke test extended** (gate G8): version N running, N+1 offered and loaded, forged N+2 refused, using two real builds.
5. **Manifest keeps history.** The release script reads the previous release's manifest (from the last GitHub Release) and lists earlier bundles too, so a rollback is a manifest change, as ADR-0005 intended.
6. **`docs/quickstart.md`**: create a project, declare a table, write a screen, invite a user, release. One page. No framework internals.
7. **Cold-start run** (gate G12): a fresh agent with only the quickstart and a created project adds a table and a screen. Record the transcript summary and the diff. If it had to open a framework file, fix the docs or the API and run it again.
8. **Release:** set the two key values (Harry, once), tag `v0.1.0`, confirm the workflow publishes the zip and that the unzipped folder passes the two-user test (gate G13).

## Defaults chosen

- `create` is a Node script in this repository, not a separate published tool.
- A created project keeps the framework folders in its own repository; taking later framework fixes is a manual copy in v0.1.0, and the quickstart says so.
- The framework's own version and a project's version are separate; both start at 0.1.0.

## Acceptance

- `npm run rubric` green in CI on the release commit.
- The `v0.1.0` GitHub Release exists with the zip and release notes listing: gates passed, the cold-start record, and known limits (no proof on real OneDrive or a work laptop, no plugins, signing key held in GitHub, manual framework upgrades).

## Needs Harry

- Run `npm run keygen` and store the two values in GitHub before step 8.
- Confirm the name before S1 starts renaming.
