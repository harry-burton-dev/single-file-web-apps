# How sync works

An app built on the framework has no server. The only link between two people's computers is a folder that some other tool, such as OneDrive, keeps in step. This page explains how data stays the same on every computer under those conditions, and what that means for the screens you write.

## The problem with a shared folder

A folder-sync tool copies whole files, seconds to minutes late. That is hard to build on:

- If two computers write the same file in that window, one write is lost or a conflict copy appears.
- A computer can see a file that is missing, half-arrived, or in the middle of being replaced.
- Nothing arrives in order.

The framework is designed so that none of these can damage data.

## Each device writes only its own files

Every browser profile that opens the app is a device. A device has an id made of the user's id and eight random characters, so one person on two computers is two devices.

A device writes only into its own folders:

```text
<shared folder>/
  workspace.json
  app/                     releases
  data/
    items/
      sam-b81x0c4d/000001.ywb
      ana-7f3k2m9q/000001.ywb
    contacts/
      sam-b81x0c4d/000001.ywb
  backups/
```

Two devices never write the same file, so the sync tool has nothing to merge and nothing to lose. Each device reads everyone else's files and applies what it finds.

## Changes merge, in any order

Each file holds a list of changes to one table, made on one device. The changes are of a kind that can be applied more than once, and in any order, and still give the same result. Yjs, a library for exactly this, does the merging.

So a late file, a duplicate file, or a conflict copy made by the sync tool is harmless. A device applies it and ends in the same state as every other device that has seen the same changes. Nothing depends on the computers' clocks agreeing.

## Two copies of everything

Each device keeps the whole of every table in the browser's own database, as well as in the folder.

- **Your screens read and write the browser's copy.** That is why a command returns at once, and why the app starts without waiting for the folder and keeps working when the folder is out of reach.
- **Either copy can rebuild the other.** A browser with cleared storage refills from the folder. Changes not yet written to the folder wait in the browser and survive a closed tab.

## When things are saved and read

Saving every keystroke would flood the folder with files, so a device waits for a pause:

| What | When |
|---|---|
| Save to the folder | After 30 seconds without a change. At the latest, 3 minutes after the first unsaved change. Never more than once in 30 seconds. At once when the window is hidden or closed. |
| Read the folder | When the app starts, and every 30 seconds. |
| Retry a failed save | After 5 seconds, then at growing intervals up to 5 minutes. |

A change therefore reaches a colleague in about a minute, plus however long the sync tool takes. It is not instant, and screens should not pretend it is. The sync status above your screens says where things stand.

## Files are encrypted

Every file in `data/` and `backups/` is encrypted with the workspace key. Without an invite, the files are unreadable. See [Keys and identity](keys-and-identity.md).

Encryption also guards against a half-arrived file. A truncated file fails its check, is skipped, and is read again on the next pass.

## Conflicts

Merging makes every device agree. It does not make the result the one people wanted. If two people set a meeting's room at the same moment, something has to happen to one of the two values. What happens is decided by each field's kind:

- **`latest`**: one value wins, the same one everywhere. The other is dropped.
- **`text`**: the two edits are merged, character by character, as in a shared document.
- **`ask`**: both values are kept, and the field is in conflict until a person picks one.

An `ask` field keeps one value per device, along with what that device had seen from the others when it wrote. A value that someone has seen and then written over is superseded. Values that were written without knowledge of each other both survive, and that is a conflict. No clock is involved in telling the two cases apart.

While a field is in conflict it still has a value, so screens are never blocked: every device shows the most recently written candidate. Picking a value is an ordinary write. It syncs like any other, and the conflict closes everywhere.

## Deleting

A removed record is marked, not erased. If one person removes a record while another edits it, the edit is not lost, and the record can be restored.

Removed content stays in the folder's older files. Over time each device writes a single snapshot of a table and, once every active device has confirmed it can read that snapshot, deletes the files the snapshot replaces. Files deleted this way go to the sync tool's recycle bin.

## What this means for your screens

- **Expect missing data.** Every field of a row can be `undefined`, and a record can arrive before the record it points at.
- **Do not keep a list in a field.** Two people adding to it at once lose an entry. Make each entry its own record.
- **Use predictable ids for things that must not be doubled.** If two people can create the same thing, build its id from its parts so both land on one record.
- **Choose `ask` where a silent wrong answer costs something**, and `latest` everywhere else.

## Related

- [Declare a table and field rules](../guides/declare-a-table.md)
- [Handle a conflict](../guides/handle-a-conflict.md)
- [Known limits](limits.md)
