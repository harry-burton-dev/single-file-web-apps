# Keys and identity

Anyone who can open the shared folder can copy its files. What stops them reading the data is encryption: every data file is encrypted with a key that only invited people hold. This page explains where that key lives and how a person comes to hold it.

## One workspace key

A workspace is one shared folder and the people invited to it. It has a workspace key, made in the admin's browser when the workspace is created. Every file under `data/` and `backups/` is encrypted with it.

The key is never stored in the shared folder. The folder holds `workspace.json`, which identifies the workspace and its current key without containing the key. The app uses it to check that a passport belongs to this folder.

## Three files that hold the key

The key travels in key files. Each is the workspace's keys, sealed with a passphrase.

| File | Who holds it | Opened with |
|---|---|---|
| Key backup, `workspace-key-1.keybackup.json` | The admin, away from the shared folder | The passphrase the admin chose |
| Invite, `sam.invite.json` | Sent by the admin to one person | A one-time passphrase, sent by another route |
| Passport, `sam.passport.json` | That person, on their own computer | The passphrase they chose |

A passphrase has at least 12 characters. Turning a passphrase into a key is made deliberately slow, which is why opening a file takes a moment, and why guessing is expensive for someone who has stolen one.

An invite and a passport also name the user. That name is where "who wrote this" comes from throughout the app.

## What happens at each launch

1. The person types their passphrase.
2. The app opens the passport and checks it against the folder's `workspace.json`.
3. The keys are loaded into the browser in a form that cannot be read back out, and are held in memory only.

Nothing secret is stored by the browser between launches. It remembers where the passport file is, not what is in it. Closing the tab forgets the keys.

The admin page works the same way. It keeps no key, and asks for the key backup and its passphrase every time.

## Why an invite and not a shared password

A shared password has to be told to everyone and cannot be taken back from one person. With invites:

- Each person chooses a passphrase that nobody else knows, the admin included.
- The invite's passphrase is used once. After the person has made their passport, the invite file can be deleted.
- The file and its passphrase travel by different routes, so intercepting one is not enough.

## Removing someone means rotating the key

Marking a user inactive is a record. It does not take the key from them: they have a passport, and it still opens the data.

To lock someone out, the admin rotates the key. The workspace gets a new current key, `workspace.json` is rewritten, and every remaining user needs a new invite. An old passport is then refused as out of date.

Rotation protects what is written afterwards. A person who kept a copy of the folder and their old passport can still read what they could read before. Data they have already seen cannot be taken back.

## What the admin must keep

- **The key backup and its passphrase.** They open the admin page. Without them, any user's passport and passphrase also do. Without those too, the data cannot be recovered by anyone, the framework's authors included.
- **A data backup, away from the folder.** See [Back up and restore](../guides/back-up-and-restore.md).

## What encryption does not cover

- **File names and sizes are visible.** Someone with the folder can see table names, user ids, and how much each device writes.
- **The app's own files are not secret.** The files under `app/` are signed, not encrypted. See [Signed updates](signed-updates.md).
- **An invited person is trusted.** Anyone with a passport can read and change every table. There are no per-table or per-record permissions.

## Related

- [Invite a user](../guides/invite-a-user.md)
- [Known limits](limits.md)
