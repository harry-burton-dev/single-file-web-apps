# S3: Identity, keys and admin

**Goal:** data is encrypted with a real workspace key that only invited users hold, and an admin page creates the workspace, invites people and backs up keys.

## Start from

- ADR-0003 (identity, keys and the admin app): the design. Read it first; where it and this spec differ, the ADR wins and the difference is reported.
- `app/test-key.ts`: the fixed key to delete.
- `framework/runtime/loader/manifest.js`, `scripts/keygen.js`, `scripts/release.js`: the signing side, already built.
- ADR-0005 action item 3 and the unbuilt `admin` build target.

## Deliver

1. **Workspace creation** (admin page): generates the workspace key (AES-GCM 256) and writes the first `users` record.
2. **Invites.** The admin enters a name; the page produces an invite file holding the user id and the workspace key, wrapped with a passphrase (PBKDF2 or Argon-free Web Crypto only, no WebAssembly). The user opens the app, picks the file, types the passphrase; the key is stored non-extractable in the browser.
3. **Key ids and rotation.** The engine already takes `keyId` and a key map. The admin page can add a new key; old chunks stay readable. Removing a user means rotating the key and re-inviting the others; the page says so.
4. **Key backup.** The admin can export the workspace key under a passphrase, and the page refuses to finish workspace creation until that export has been downloaded.
5. **Admin build target.** `admin.html`, a single file that does not go through the loader and works with an empty or broken folder.
6. **App side.** First run asks for an invite, not a name. The test key and typed-name path are deleted.

## Defaults chosen

- Release signing stays in GitHub Actions for v0.1.0 (ADR-0005 section 9). The admin page does not sign releases yet.
- One role only besides admin: member. No per-table permissions.
- Passphrase stretching: PBKDF2-SHA-256, 600,000 iterations.

## Acceptance (gate G6)

- Automated test, written first: admin creates a workspace and two invites; both users read each other's edits; a third party with folder access but no invite can decrypt nothing; a wrong passphrase is refused with a message.
- After rotation, a user with only the old key reads old data but not new data.
- `grep` finds no fixed key or seed in the build output.
- `admin.html` opens from disk in the smoke test and completes workspace creation against a stand-in folder.

## Out of scope

Signed per-user changes, single sign-on, recovering a lost workspace key (impossible by design; the backup step exists because of it).

## Stop and report if

ADR-0003 requires something this spec's defaults contradict, or Web Crypto on a page opened from disk refuses a needed operation.
