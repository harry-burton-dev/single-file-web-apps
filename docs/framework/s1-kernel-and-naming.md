# S1: Kernel and naming

**Goal:** the repository is laid out as a framework plus an app, and everything an app is called is declared once.

## Start from

- `workbench/src/host/host.ts`, `folder.ts`, `bootstrap/main.ts`, `app/app.tsx`: every literal "workbench".
- `workbench/vite.config.ts`, `scripts/*.js`, `.github/workflows/*.yml`: build and release names.
- `masters/*.html`: entry pages.

## Deliver

1. **Layout.** Rename and regroup, moving files without changing behaviour:
   - `framework/engine/` (today `sync-engine/`), `framework/runtime/` (host, loader, bootstrap, later identity and shell), `app/` (the only folder a project edits), `masters/` unchanged in role.
   - npm workspaces so `app/` imports `@trellis/framework` and never a relative path into it.
2. **`app/app.config.ts`**, the single definition: `{ id, name, tables: { <table>: <schema> } }`. `id` is lower-case letters, digits and hyphens.
3. **Derived names.** Database name, device lock name, folder-picker id, page title, bundle file prefix and release zip name all come from `id` and `name`. Key variables become `TRELLIS_PUBLIC_KEY` and `TRELLIS_SIGNING_KEY`.
4. **Public entry.** `framework/index.ts` exports what an app may use; nothing else is importable from `app/` (enforced in S2).

## Defaults chosen

- Template repository, not published packages: a project is a copy. Workspaces keep the boundary honest inside the copy.
- The framework name appears only in the workspace package name and one attribution line.
- Existing stored data under the old database name is not migrated; nothing real has been stored.

## Acceptance

- A test changes `id` and `name` in the config and asserts the page title, database name, lock name and bundle file name all follow (gate G3).
- A test starts the runtime with `tables: {}` (gate G4).
- `grep -ri workbench` over tracked source returns nothing.
- Engine tests, loader tests, typecheck, build and smoke test pass after the move.

## Out of scope

Any new behaviour. This epic only moves, renames and centralises.
