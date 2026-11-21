# ADR-0009: UI in React, TypeScript and shadcn/ui

**Status:** Accepted for the framework choice (decided 2026-11-21); the binding details below are Proposed
**Date:** 2026-11-21
**Deciders:** Harry
**Epic:** EA · EA Workbench
**Related:** ADR-0005 (build and loader), ADR-0006 (plugins), ADR-0007 (commands), ADR-0008 (queries)

## Context

The layers below the screen are framework-neutral: commands to write (ADR-0007), queries to read (ADR-0008), engine health and traces to show sync state (ADR-0004). The screen layer needs a framework that bundles into the single-file build, runs from a page opened from disk, and that plugins can use.

## Decision

The UI is **React** (version 19), bundled by Vite.

### 1. Screens touch three things only

| Hook | Wraps | Purpose |
|---|---|---|
| `useQuery(name, params)` | `queries.subscribe` / `queries.get` | Current result of a query; re-renders when it changes |
| `useCommand(name)` | `commands.run` | A function that runs the command and returns its result |
| `useHealth()` | `engine.health()` and its change event | Connection state and latest sync, for the indicator |

- `useQuery` is built on React's `useSyncExternalStore`. That needs the same object back when nothing changed, which the query layer already guarantees.
- Components never import Yjs, the record layer or the engine.
- Data the user is editing but has not committed (a half-typed field) is ordinary React state. It becomes shared data only when a command runs.

**As built (TR2, spec S2):** `useQuery` became three read hooks, `useRecords(table, query?)`, `useRecord(table, id)` and `useField(table, id, field)`, plus `useConflicts()` and `useResolveConflict()` for "ask" conflicts. `useCommand(name)` returns a function that runs the command synchronously and returns its result; it never throws. The shell (`<TrellisApp>`) makes the data runtime once per started engine and puts the screens inside `<DataProvider>`. Row and field types are inferred from `app/app.config.ts`. The public entry no longer exports the engine, `startHost`, `SharedMap` or `useEngine`, so a screen cannot reach them.

### 2. Plugins share the host's React

A plugin is a separate bundle (ADR-0006). If it carried its own copy of React, its components could not use hooks alongside the app's. So:

- The host passes React to each plugin through `ctx` (`ctx.React`, plus the three hooks above).
- Plugins are built with React marked as external and resolved to the host's copy.
- A plugin written without a build step can use `ctx.React.createElement` directly.
- The React major version becomes part of the plugin contract.

### 3. Failure containment

Every plugin view, and every top-level screen, is rendered inside a React error boundary. A view that throws shows a contained error with the plugin's name; the rest of the app keeps working.

### 4. Language: TypeScript (decided 2026-11-21)

- The app, and every layer written from now on (commands, queries, host layer, loader, plugins), is TypeScript in strict mode. `npm run typecheck` must pass before a release.
- **The existing engine stays JavaScript for now.** It has 250 passing tests and is imported by the app as plain modules. Converting it is a separate, later step, once the current engine work has landed, so the conversion can be checked against an unchanged test suite. Node 24 runs TypeScript directly, so the engine would still need no build step.
- Until then the app sees the engine's API untyped. Type declarations for the engine's public surface are the first part of that conversion.

### 5. Components: shadcn/ui (decided 2026-11-21)

- Components come from shadcn/ui and are copied into `workbench/src/components/ui`, so they are owned source, not a runtime dependency.
- Styling is Tailwind CSS 4, compiled at build time to only the classes used.
- **No bundled web fonts.** The default setup inlined a font that added about 100 KB. The app uses the system font stack; nothing is fetched from the network.
- Icons are `lucide-react`, included only as used.

**Plugins and styling.** Tailwind only generates the classes it finds at build time, so a plugin cannot rely on classes the host happened to include. The host therefore exposes its shadcn components to plugins through `ctx.ui`, and a plugin that needs further styling ships its own compiled stylesheet inside its bundle.

### 6. Not decided here

Routing and screen layout. These are app-level choices and do not affect the layers below.

## Options Considered

| Option | Drawback |
|---|---|
| **React (chosen)** | About 220 KB added to the bundle; plugins must share one copy |
| Preact | Smaller, but plugin authors meet compatibility edge cases |
| Svelte or Solid | Smaller output; plugins would need the compiler; less widely known |
| No framework | Smallest; every screen and plugin hand-rolls updates |

## Consequences

**Easier**

- A widely known way to write screens and plugins.
- The query layer's change notifications map directly onto React's external-store support.

**Harder**

- The app bundle is larger. Smoke-build sizes: engine and Yjs 110 KB; with React 329 KB; with Tailwind and two shadcn components **397 KB (126 KB compressed)**. The budget in ADR-0005 is 500 KB, and the record, command and query layers and the app itself still have to fit, so the budget will have to be raised or the bundle split.
- The `shadcn` package's own tooling reports 4 moderate advisories. It is used at build time only and is not in the shipped file, but it should be kept current.
- Upgrading React's major version is a breaking change for plugins.
- Plugins that use JSX need a build step.

**Verified (development machine, headless Chrome, page opened from disk)**

- A single-file build containing React 19, the engine and the Yjs adapter loads and renders.
- A value changed in a Yjs document reaches a React component through `useSyncExternalStore`.
- The same build written in TypeScript with shadcn components passes the type check and renders.

**Not yet verified**

- The same on the work laptops.
- A plugin bundle sharing the host's React.

## Action Items

1. [x] Build the read hooks, `useCommand` and `useHealth` (TR2 and TR4; `useQuery` became `useRecords`, `useRecord` and `useField`).
2. [ ] Add React, as an external, to the plugin build and the plugin contract.
3. [ ] Add error boundaries around screens and plugin views.
4. [ ] Revisit the 500 KB budget once the first real screens exist.
