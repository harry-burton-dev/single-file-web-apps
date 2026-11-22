# Messages

Every message the app can show a person, with its cause and what to do. Messages are quoted in their default wording. An app can reword the shell's own text through the `strings` prop of `<TrellisApp>`; the name in the last column is the property to set.

## Sync status

The badge above your screens shows one of six states. Next to it is one sentence.

| Badge | Sentence | What to do | `strings.health` key |
|---|---|---|---|
| Saved | Your changes are saved to the shared folder. | Nothing. | `saved` |
| Saving | Your latest changes are being saved to the shared folder. | Nothing. Saves wait for a pause in typing. | `saving` |
| Retrying | Saving to the shared folder failed and will be tried again shortly. Your changes are safe on this computer. | Nothing, unless it lasts. Then check that the folder is reachable and not held by another program. | `retrying` |
| Folder disconnected | Folder disconnected. Your changes are safe on this computer and will be shared once the folder is reconnected. | Choose **Reconnect** if it is offered. Otherwise check that the folder still exists. | `folder-disconnected` |
| Not reaching colleagues | Your changes are saved, but colleagues' copies have not picked them up yet. | Check that the folder is syncing between computers. | `not-reaching-peers` |
| Offline | You are offline. Your changes are safe on this computer and will be shared when you are back online. | Nothing. | `offline` |

Beside the badge:

| Text | Meaning | Property |
|---|---|---|
| Starting | Sync has not started yet. | `starting` |
| 3 waiting | Three changes are not yet saved to the folder. | `waiting` |
| Last save 14:02 | When this computer last saved. "never" before the first save. | `lastSave`, `never` |
| Last folder read 14:03 | When this computer last read the folder without an error. | `lastFolderRead` |
| sam heard 14:01 | When this computer last heard from that colleague's device. | `peerHeard` |

The badge opens a menu with one item, **Diagnostics**. It shows save and read timings, the backlog, conflict counts, errors and the recent sync attempts, with **Save now** and **Read folder now**.

## Starting the app

| Message | Cause | What to do | Property |
|---|---|---|---|
| Choose the shared folder | The app does not know the folder yet. | Choose it. | `chooseFolder` |
| Reconnect to "Team" | The browser remembers the folder but no longer has access. | Choose the button and allow access. | `reconnectTo` |
| Allow access to the folder to continue. | Access was refused in the browser's prompt. | Try again and allow it. | `folderRefused` |
| To open My App on this computer you need an invite from the admin, or the passport you saved from one. | The folder is connected and this browser has no passport. | Choose **I have an invite** or **I have a passport**. | `passportIntro` |
| Choose the invite file first. | **Open the invite** was chosen with no file. | Pick the invite file. | `chooseInviteFirst` |
| The two new passphrases do not match. | The passphrase and its confirmation differ. | Type them again. | `passphrasesDiffer` |
| Invite accepted for sam. Save your passport somewhere on this computer, not in the shared folder. … | The invite opened. | Choose **Save my passport**. | `inviteAccepted` |
| The passport was not saved. Save it to continue. | The save dialog was cancelled. | Save the passport. | `passportNotSaved` |
| Passphrase for your passport "sam.passport.json" | The app is ready to unlock. | Type your passphrase. | `passphraseFor` |
| Allow access to your passport file to continue. | The browser no longer has access to the passport file. | Allow it when asked. | `allowPassport` |
| My App is already open in another tab. Close it there, then try again. | One tab at a time can sync from one browser. | Close the other tab, then **Try again**. | `alreadyOpen` |
| This browser would not open its local storage, which the app needs. A private window or blocked site data can cause this. | The browser refused to open its database. | Use a normal window, and allow site data. | `storageUnavailable` |

Messages about the invite, the passport and the workspace are listed under [`KeyFileError`](api.md#keyfileerror) and [`PassportError`](api.md#passporterror). They are fixed wording and are not in `strings`.

## While the app is running

| Message | Cause | What to do | Property |
|---|---|---|---|
| This browser no longer has access to "Team". Your changes are safe on this computer and will be shared once you reconnect. | The browser dropped its access to the folder. | Choose **Reconnect**. | `reconnectBanner` |
| Reconnected. Catching up with the folder. | Access is back. | Nothing. | `reconnected` |
| 1 needs a decision | An `ask` field holds more than one value. | Open it and choose **Keep** on one value. | `needsDecision` |
| Something went wrong | A screen threw an error. | Choose **Open diagnostics** to see what failed. | `errorTitle` |
| Open a new invite | Always shown. | Use it after the admin rotates the key and sends you a new invite. | `newInvite` |

## Updates

| Message | Cause | What to do | Property |
|---|---|---|---|
| Version 0.2.0 is ready. | A new signed version is in the folder and has been checked. | Choose **Load it**, or reload the page later. | `updateReady` |
| A new version was not installed. … | The release in the folder was refused. The reason follows. | See the table below. Everyone keeps running the version they have. | `updateRefused` |

The reason is one of:

| Code | Reason shown | Cause |
|---|---|---|
| `manifest-missing` | This folder has no release manifest (app/manifest.json). | The folder has never had a release copied into it, or the wrong folder was chosen. |
| `manifest-unreadable` | The release manifest could not be read. It may still be syncing. | The file is partly synced. The check runs again by itself. |
| `manifest-invalid` | The release manifest is not valid: … | The file is not a manifest the app understands. Copy the release in again. |
| `signature-invalid` | The release manifest is not signed by this app's admin. It was ignored. | It was signed with a different key from the one in the page people open. |
| `serial-replayed` | The release manifest (serial 1) is older than one already accepted (serial 2). It was ignored. | An older manifest was copied over a newer one. To go back a version, [roll back](../guides/roll-back.md). |
| `channel-unknown` | The release manifest has no "stable" channel. | The manifest was not written by the release script. |
| `bundle-unlisted` | The release manifest names version 0.2.0 but does not describe it. | The manifest was not written by the release script. |
| `bundle-missing` | Version 0.2.0 has not arrived in the folder yet (my-app-0.2.0.js). | The app file is not in `app/` yet. Copy it in, or wait for it to sync. |
| `bundle-hash-mismatch` | Version 0.2.0 in the folder does not match the release manifest. It may still be syncing. | The app file is partly synced, or was changed after release. |
| `bootstrap-too-old` | Version 0.2.0 needs a newer bootstrap page. Ask the admin for the current one. | The HTML file this person opens is from an older release. Give them the current one. |
| `folder-unreadable` | The shared folder could not be read (…). | The browser could not read the folder. Reconnect it. |

Before any version has loaded, the page itself shows:

| Message | Cause |
|---|---|
| Connect the shared My App folder to load the app. | First run in this browser. Choose the shared folder. |
| No version could be loaded from this folder. | The folder holds no release this page accepts. |
| There is no previous version stored in this browser. | The page was opened with `#previous`, and this browser has loaded only one version. |

## Commands

A command does not show a message by itself. It returns a result, and your screen decides what to show. [Write a command](../guides/write-a-command.md#handle-a-failure) lists the codes.

## Admin page

The admin page's messages are fixed wording.

| Message | Cause |
|---|---|
| The admin page is already open in another tab. Use that tab, or close it and try again. | One admin page at a time can work on a folder from one browser. |
| The two passphrases are different. | A passphrase and its confirmation differ. |
| This key file is for a different workspace. | The key backup or passport belongs to another folder. |
| This key file is out of date: the workspace has a newer key. Use the latest key backup. | The key was rotated after this backup was made. |
| The workspace file in this folder is damaged. You can rewrite it from this key file. | `workspace.json` cannot be read. Choose **Rewrite workspace.json from this key file**. |
| This folder already has a workspace. Restore only into an empty folder. | A restore was tried on a folder that is in use. |
| This folder now has a workspace. Reload the page and open it. | Someone else created the workspace while the create form was open. |

[Back up and restore](../guides/back-up-and-restore.md#what-a-restore-refuses) lists the messages a restore can stop with.
