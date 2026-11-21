# ADR-0003: Identity, keys and the admin app

**Status:** Proposed
**Date:** 2026-11-20
**Deciders:** Harry
**Epic:** EA · EA Workbench
**Related:** ADR-0001 (sync engine)

## Context

The sync engine encrypts every file it writes and tags each change with the user and device it came from. It needs a key and an identity from somewhere. There is no server, so there are no logins. The users are three trusted colleagues, and access to the shared folder is already controlled by OneDrive permissions.

## Decision

### 1. One shared workspace key (decided)

- All users share a single AES-256 key for the workspace.
- Access control is the folder's permissions. The key protects the data from anyone who can see the files but was not given the key.
- Each file carries a key id, so the key can be rotated later.

### 2. Minting users

An **admin app**, built from the same core as the main app, mints users:

1. The admin enters a name. The admin app creates a user id and a record in the `users` table.
2. It produces an **invite file** containing the user id, name and the workspace key, wrapped with a passphrase (PBKDF2, then AES-GCM).
3. The admin gives the user the file and, separately, the passphrase.
4. The user opens the invite once in the main app. The key is stored in the browser as a non-exportable key, and a device id is created for that browser profile.

### 3. Identity

- **User id:** from the invite. **Device id:** `<user>-<8 random characters>`, per browser profile.
- The `users` table is an ordinary synced table: id, name, status.
- Authorship is taken from the device a chunk came from. It is not cryptographically proven: anyone holding the key could write as anyone. This is accepted for a small trusted team.

### 4. Removing a user

- Remove their access to the folder.
- Mark them inactive in the `users` table.
- Keep their device folders; they hold their changes.
- Rotate the key if they should no longer be able to read copies they may have kept.

### 5. Admin app responsibilities

- Mint users and produce invite files.
- Generate and rotate the workspace key.
- Write and restore backups.
- Run compaction when it exists.
- Exclude a faulty device's chunks after a given time, for recovery.

## Options Considered

| Option | Complexity | Drawback |
|---|---|---|
| **A. One shared key, passphrase-wrapped invites (chosen)** | Low | Removing someone relies on folder access and, if needed, rotation |
| B. A key pair per user, workspace key wrapped for each | Medium | More key handling for little gain at three users |
| C. Signed changes per user | Medium to high | Proves authorship; unnecessary for a trusted team |
| D. No encryption | None | Files readable by anyone with folder access; no integrity check |

## Consequences

- **Losing the workspace key loses the data.** The admin must keep a copy of the key outside the browser.
- Onboarding is one file and one passphrase per person.
- The local key lives in browser storage. On a page opened from disk, other local HTML files may be able to use it.
- Encryption does not erase history: old chunks and OneDrive's version history still hold removed content, encrypted.

## Action Items

1. [ ] Specify the invite file format alongside the engine's envelope.
2. [ ] Build minting and invite import in the test page.
3. [ ] Write the key backup procedure for the admin.
4. [ ] Confirm Web Crypto and non-exportable key storage work on a page opened from disk.
