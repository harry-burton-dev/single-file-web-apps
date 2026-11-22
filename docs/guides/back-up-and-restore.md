# Back up and restore

A backup is an encrypted copy of every table. You make one on the admin page, and you restore it into an empty folder. Restoring needs the backup and the key backup together.

**You will learn**

- How to make a backup and take it out of the folder
- How to restore into an empty folder
- What a restore refuses to do

## Make a backup

1. Open the admin page and open the workspace. See [Invite a user](invite-a-user.md#open-the-admin-page).
2. Under **Backups**, choose **Back up now**.

The page writes one file per table to `backups/<stamp>/` in the shared folder, where the stamp is the time in UTC. Nothing is overwritten: a second backup gets its own folder.

3. Choose **Download backup**. The browser saves `backup-<stamp>.zip`.

Keep the zip away from the shared folder, with the key backup. A backup in the folder protects you from a bad change. It does not protect you from losing the folder.

> **Note**
>
> There are no scheduled backups. A backup exists only when someone has chosen **Back up now**.

## Restore into an empty folder

1. Make a new, empty folder and choose it on the admin page.
2. Under **Restore into an empty folder**, pick the key backup file, type its passphrase, and pick the backup zip.
3. Choose **Restore into an empty folder**.

The page reads and decrypts the whole zip before it writes anything. It then writes the data and, last, `workspace.json`. The workspace opens with every table as it was when the backup was made.

Existing users keep their passports. Point them at the new folder: in the app, they choose the folder again and unlock as usual.

## What a restore refuses

A restore stops, with nothing written, when:

| Message | Cause |
|---|---|
| "This folder already has a workspace. Restore only into an empty folder." | The folder has a `workspace.json`. |
| "This folder already has a data/ folder. Restore only into an empty folder." | The folder holds data from another workspace. |
| "This file is not a readable backup." | The zip is damaged or is not a backup. |
| "This backup cannot be opened with this workspace's keys." | The key backup does not hold the key this backup was made with. |
| "This backup holds a table "x" that this app does not open." | The backup was made by a version of the app with a table this version does not declare. |
| "This device already holds data for "x". Restore from a device with no local data." | This browser's admin page has already worked on a workspace with that table. Use another browser profile. |

## Troubleshooting

### "Back up first."

**Download backup** packs the backup made in this session. Choose **Back up now**, then download.

### "The restored data could not be written to the folder. Check the folder and try again."

The browser could not write to the folder. Check that the folder still exists and that you allowed the page to edit it.

## Next steps

- [Invite a user](invite-a-user.md)
- [Keys and identity](../explanation/keys-and-identity.md)
