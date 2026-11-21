# ADR-0006: Plugins as signed files

**Status:** Proposed (direction agreed 2026-11-21: plugins are files, loaded by the loader mechanism, and must be signed)
**Date:** 2026-11-21
**Deciders:** Harry
**Epic:** EA · EA Workbench
**Related:** ADR-0002 (data model), ADR-0005 (loader, signing)

## Context

The engine and loader are meant to be a foundation for many features and apps. The loader (ADR-0005) can already read a script from the shared folder, verify it and run it. The same mechanism can add a view or feature for the whole team by adding a file.

A plugin runs in the same page as the app, with access to the workspace key and the folder. Loading any script that appears in a folder would let anyone with write access run code in every colleague's browser.

## Decision

### 1. What a plugin is

- One ES module file, write-once, named `plugins/<id>-<version>.js`.
- **A plugin runs only if it is listed in the signed manifest** (ADR-0005) with a matching hash. Putting a file in the folder does nothing by itself.
- Installing is an admin action: the admin app adds the file to the manifest and signs it. Everyone receives it on their next update check.
- Removing is taking it out of the manifest. The plugin's data stays.

### 2. Contract

```js
export default {
  id: "checklists",
  version: "1.2.0",
  apiVersion: 1,
  activate(ctx) { /* register things; return a function that undoes it */ },
};
```

`ctx` lets a plugin register:

| Registration | Purpose |
|---|---|
| Tables | Declare record types and field kinds; sync, conflicts and versioning come from the engine |
| Commands | Named actions that change data |
| Views and panels | Screens, and panels in agreed places on existing screens |
| Importers | Sources of read-only outside data |

It also gives read access to the activity feed and sync health. A plugin never touches the folder, the key or Yjs directly.

Views are React components (ADR-0009). `ctx` supplies the host's copy of React and the data hooks; a plugin must not bundle its own React.

The contract has a version. A plugin built for a newer major version than the app supports is refused with a clear message.

### 3. Loading and failure

- Plugins load after the core, in manifest order.
- Each load and each registered callback is wrapped. A plugin that throws is disabled for the session, listed with its error in a Plugins panel, and does not stop the app starting.
- `#safe` starts the app with no plugins.

### 4. Data

- A plugin's tables are namespaced `<pluginId>.<table>`.
- Tables carry schema versions as in ADR-0002. An older plugin that meets newer data stops writing to it.

### 5. Trust

Plugins run with full trust. There is no sandbox. The control is the signature: only code the admin chose to sign runs.

### 6. First-party features are plugins

The app's own features are built as plugins from the start, so the contract is proven by real use and not designed in the abstract.

### 7. Development

The dev server (`localhost`) can load an unsigned local plugin. That path is compiled out of the release bootstrap.

## Options Considered

| Option | Complexity | Drawback |
|---|---|---|
| **A. Signed plugins listed in the manifest (chosen)** | Medium | Installing needs the admin |
| B. Any script in `plugins/` runs | Low | Anyone with folder access runs code for everyone |
| C. Sandboxed plugins (frame or worker) | High | A large project; limits what a plugin can show and do |
| D. No plugins; features compiled into the bundle | Low | Every feature is a full release; no per-team additions |

## Consequences

**Easier**

- A feature is a file plus a manifest entry, not a release of the whole app.
- Plugin data syncs and resolves conflicts without plugin code for it.
- A bad plugin can be removed or bypassed without touching the app.

**Harder**

- The contract is a long-term commitment; changing it breaks plugins.
- Full trust means a signed plugin can do anything the app can.
- Depends on the command layer and table registry, which are not designed yet.

## Action Items

1. [ ] Design the command layer and table registry (own ADRs).
2. [ ] Define contract version 1 by building the first feature as a plugin.
3. [ ] Add install, remove and the Plugins panel to the admin app and the app.
4. [ ] Test loading with a missing, altered, unsigned, throwing and too-new plugin.
