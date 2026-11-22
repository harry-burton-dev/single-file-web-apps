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

## As built (TR4, closed 2026-11-22)

Every acceptance point, with the test that checks it on `main`. All run in CI (`.github/workflows/ci.yml`).

| Acceptance | Checked by |
|---|---|
| G7: two contexts, one stand-in folder, edits both ways converge; a concurrent `owner` edit raises the conflict prompt | `npm run two-users` (`framework/build/test/two-users.js`), from built files opened from disk. Also `conflict-prompt.test.tsx` ("two engines: a concurrent ask edit shows the prompt on both; resolving on one clears both") |
| G11: sizes within budget, enforced by the build | `npm run size` at the end of `npm run build` (`framework/build/size-budget.js`): bootstrap 9,535 of 50,000 bytes, bundle 466,580 of 500,000. `framework/test/size-budget.test.js` proves it exits 1 over budget |
| Component tests for each shell state | `framework/runtime/shell/test/trellis-app.test.tsx`: starting, invite, unlock, folder (none and needs permission), already open, running, failed. Transitions in `machine.test.ts` |
| Including folder permission lost mid-session | `trellis-app.test.tsx`, "folder permission lost mid-session": banner with Reconnect, clears once granted and the next folder operation succeeds, refusal stays, no banner while permission holds |
| Deleting the example table and screen leaves a project that builds and shows an empty shell | `empty-app-build.test.ts` (builds with `tables: {}` and no screens through the Vite factory and mounts the bundle) and "an empty shell" in `trellis-app.test.tsx` |
| Example under 150 lines | `framework/test/app-size.test.js`: 80 of 150 |
| No shell text or colour hard-coded | `rules.test.tsx`: sentinel strings for every shell piece and first-run screen, and no colour except design tokens under `shell/` |

Defaults kept as written. The update notice uses the optional `onUpdate` loader service (approved by Harry, 2026-11-21); with no subscriber the bootstrap still draws its own plain note, whose wording is outside the strings file.

Known follow-ups, recorded on Linear: the conflict prompt shows user ids rather than display names, and offers only the candidate values (no way to type another). The G4 scan for app field names skips the engine's simulation harness, whose synthetic tables use the same field names.

### Not verified

- The real folder picker, and the real passport save and open pickers. Headless Chrome cannot drive them, so the two-user test hands the page a stand-in folder.
- A real OneDrive folder shared by two browser profiles, with its upload delays, conflict copies and placeholder files.
- The reconnect banner after a real permission lapse in Chrome.
- Work laptops and their browser policies.

### Manual check: two Chrome profiles on a real folder

Takes about 20 minutes. Use a folder synced by OneDrive (or any synced folder both profiles can reach on one machine).

1. Build a release: `npm ci`, then `npm run --silent keygen` and export the two printed keys as `TRELLIS_PUBLIC_KEY` and `TRELLIS_SIGNING_KEY`, then `npm run release`. Copy the contents of `dist/release/<name>/` into the shared folder.
2. In Chrome profile A, open `<id>-admin.html` from the folder, choose the folder, create the workspace and save the key backup somewhere outside the folder. Invite two people, A and B, each with a one-time passphrase, and save both invite files.
3. Still in profile A, open `<id>.html` from the folder. Accept invite A, save the passport, choose the shared folder. The example app's items screen shows.
4. In Chrome profile B, open the same `<id>.html`, accept invite B and choose the same folder.
5. In A, add an item. Within a few minutes (or press Diagnostics, then "Read folder now" in B) it appears in B. Edit its title in B and check A.
6. Concurrent edit: pause OneDrive sync, set a different owner on the same item in A and in B, then resume sync. After both have read the folder, both show "1 needs a decision". Pick one in A; B's count clears and both show that owner.
7. Permission lapse: in B, remove the page's file access (the file-access icon in the address bar, or close every tab of the page and reopen it, which drops the grant), then add an item. If Chrome offers no way to remove it, note that and skip this step. The reconnect banner appears and the item stays on screen. Press Reconnect, allow access, and check A receives the item.
8. Look in the folder for OneDrive conflict copies (files with a computer name in them) and note any in Diagnostics' file list.

Record the result, and any conflict copies seen, on the TR4 Linear project.
