# S4: App shell and example app

**Goal:** the framework supplies every screen that is not business logic, and a small example proves a new app needs only a config and screens.

## Start from

- `app/app.tsx` (today's test page), `connection-indicator.tsx`, `sync-inspector.tsx`.
- The bootstrap's connect-folder screen and update notice (`framework/runtime/bootstrap`).
- ADR-0004 (health and presence), ADR-0009 (UI).

## Deliver

1. **Shell component** `<TrellisApp config={...}>{screens}</TrellisApp>` that owns, in order: invite (S3), choose or reconnect the folder, "already open in another tab", then the app's screens.
2. **Always-available pieces:** health indicator with plain-language states, update-ready notice, conflict prompt (default UI for S2's conflicts), error boundary that shows the error and offers the diagnostics view, and the diagnostics view (the existing inspector) behind a menu item.
3. **Theming hook.** The shell's pieces use the project's Tailwind tokens so an app's design applies to them; no shell text or colour is hard-coded to one app.
4. **Example app** in `app/`: one table (`items`: title "latest", done "latest", notes "text", owner "ask") and one screen listing, adding and editing items. It is what a new project deletes or rewrites.
5. **Two-user test** from built files opened from disk (gate G7), using the example app.

## Defaults chosen

- The shell is not optional in v0.1.0; an app cannot replace the first-run flow, only style it.
- All shell wording lives in one strings file so an app can reword it.
- The example stays under 150 lines of app code. If it needs more, the framework is missing something; fix that instead.

## Acceptance

- Gate G7: two browser contexts, one stand-in folder, edits both ways converge; a concurrent "owner" edit raises the conflict prompt.
- Gate G11: sizes within budget, enforced by the build.
- Component tests for each shell state, including folder permission lost mid-session.
- Deleting the example table and screen leaves a project that still builds and shows an empty shell.

## Out of scope

Routing, navigation chrome, a component library beyond what exists, the EA diary product.
