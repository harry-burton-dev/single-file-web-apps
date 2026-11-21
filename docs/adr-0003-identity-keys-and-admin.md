# ADR-0003: Identity, keys and the admin app

**Status:** Accepted (2026-11-21, built in TR3; passport model amendments in sections 2 and 6)
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
4. The user opens the invite once in the main app, chooses their own passphrase, and the app saves a **passport** file on their machine: the same keys, wrapped under the user's passphrase. The invite can then be thrown away. A device id is created for that browser profile.
5. On every launch the user selects their passport (remembered after the first time) and types their passphrase. The app checks the passport against `workspace.json` in the folder and holds the keys in memory, as non-extractable keys, for that session only. No key is kept in browser storage. (Amended 2026-11-21: passport model, TR3 decisions D4 to D6 and D12.)

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

### 6. File formats

Written for TR3 (action item 1). The engine's envelope is unchanged; these are new files.

**Keyring.** One shape everywhere, in memory and as the encrypted part of every key file:
`{ "workspace": "<16 lower-case letters and digits>", "current": <key id>, "keys": [{ "id": <1-255>, "raw": "<base64, 32 bytes>" }] }`.
The first key id is 1; 0 was the fixed test key and is never issued. Invites and passports add `"user": { "id", "name" }`.

**Key file** (invite `<user-id>.invite.json`, key backup `workspace-key-<current>.keybackup.json`, passport `<user-id>.passport.json`):

```json
{
  "format": 1,
  "kind": "invite",
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<base64, 16 bytes>" },
  "iv": "<base64, 12 bytes>",
  "data": "<base64, AES-256-GCM ciphertext of the keyring JSON>"
}
```

- `kind` is `invite`, `key-backup` or `passport`.
- The wrapping key is PBKDF2 over the passphrase (NFKC-normalised, UTF-8) with the `kdf` settings, giving an AES-GCM 256 key. Web Crypto only.
- Additional authenticated data is the UTF-8 of `keyfile-1:<kind>`, so one kind cannot be passed off as another.
- Sealing refuses a passphrase under 12 characters. Opening refuses any `format` other than 1, any other KDF, and fewer than 600,000 iterations.
- Code: `framework/runtime/identity/keyfile.js`.

**`workspace.json`** (root of the shared folder, not secret):

```json
{ "format": 1, "id": "<workspace id>", "checks": { "1": { "iv": "<base64, 12 bytes>", "data": "<base64>" } } }
```

Each check is the workspace id (UTF-8) encrypted with that key id's key under AES-GCM, additional authenticated data `workspace-check-1`. One entry per key id ever issued. A passport is refused as *for a different workspace* if the ids differ or one of its keys does not open its check, and as *out of date* if the file lists a key id the passport lacks. Code: `framework/runtime/identity/workspace.js`; enrol and unlock in `passport.js`.

## Options Considered

| Option | Complexity | Drawback |
|---|---|---|
| **A. One shared key, passphrase-wrapped invites (chosen)** | Low | Removing someone relies on folder access and, if needed, rotation |
| B. A key pair per user, workspace key wrapped for each | Medium | More key handling for little gain at three users |
| C. Signed changes per user | Medium to high | Proves authorship; unnecessary for a trusted team |
| D. No encryption | None | Files readable by anyone with folder access; no integrity check |

## Consequences

- **Losing every copy of the workspace key loses the data.** The admin keeps a key backup; since the passport model, any user's passport and its passphrase also hold every key, so the keyring can be rebuilt from one.
- Onboarding is one file and one passphrase per person.
- The user types their passphrase at every launch. No key lives in browser storage, so other local HTML files cannot use it and someone at the unlocked laptop needs the passphrase.
- A passport is only as strong as its passphrase: 12 characters minimum and 600,000 PBKDF2 rounds, about half a second to a second at each unlock.
- Encryption does not erase history: old chunks and OneDrive's version history still hold removed content, encrypted.

## Action Items

1. [x] Specify the invite file format alongside the engine's envelope. (Section 6; TR3 OUT-8.)
2. [x] Build minting and invite import in the test page. (Admin page `admin.html` mints invites, OUT-10; the app enrols from an invite and unlocks a passport, OUT-11.)
3. [x] Write the key backup procedure for the admin. (The admin page will not finish creating a workspace or a rotation until the key backup has been downloaded, and reopens the workspace from that backup, OUT-10.)
4. [x] Confirm Web Crypto and non-exportable key storage work on a page opened from disk. (`npm run smoke` from `file://` in headless Chrome: PBKDF2 and AES-GCM work, unlocked keys are non-extractable and nothing key-like is in IndexedDB. Since the passport model no key is stored in the browser at all.)

## Differences found while building (TR3)

- The engine took one key, not a key map; an optional `keys` input was added for reading after rotation (TR3 decision D16).
- The key is no longer stored in the browser: it is held in memory for the session and at rest only in the user's passport (D4 to D6, D12).
- `workspace.json` was added so a passport can be matched to its folder and an out-of-date one refused after a rotation (D13, D14).
- Chrome refuses the browser's private file area on a page opened from disk, so the smoke tests use an in-page stand-in folder. Remembering a real passport or folder handle from disk is not covered by a test and is worth checking once by hand.
