# Invite a user

Only invited people can read a workspace's data. The admin makes an invite file on the admin page, and the person turns it into a passport that stays on their own computer.

**You will learn**

- How to create a workspace
- How to invite someone, and what they do with the invite
- How to remove someone

## Open the admin page

The admin page is one HTML file. In a release it sits in the shared folder as `<id>-admin.html`. In development, `npm run build` writes it to `dist/admin.html`. Open it from disk in Chrome or Edge, and choose the shared folder.

The page keeps no key in the browser. Each time you open a workspace, it asks for the key backup file and its passphrase.

## Create the workspace

A folder with no workspace shows the create form.

1. Type your name and a passphrase of at least 12 characters, then **Create the workspace**.
2. Download the key backup, `workspace-key-1.keybackup.json`. Keep it away from the shared folder.
3. Choose **Finish**.

The page writes `workspace.json` to the folder and adds you as the first user, with the role `admin`.

> **Pitfall**
>
> The key backup and its passphrase are the way back into the admin page. If you lose both, any user's passport and passphrase also open it. If those are lost too, the data cannot be read by anyone.

## Invite someone

1. Under **Invite a user**, type the person's name and a one-time passphrase of at least 12 characters.
2. Choose **Invite**. The browser saves `<user id>.invite.json`.
3. Give the person the file. Tell them the passphrase by another route.

You are a user too. To use the app yourself, choose **New invite** on your own row.

## What the invited person does

1. They open the app from the shared folder and choose the folder when asked.
2. They choose **I have an invite**, pick the invite file, and type its passphrase.
3. They choose their own passphrase, of at least 12 characters.
4. They save their passport, `<user id>.passport.json`, somewhere on their own computer, not in the shared folder.

From then on the app asks for their passphrase at each launch. The invite file can be deleted.

## Remove someone

**Mark inactive** records that a person has left. It does not stop them reading data, because they still hold the key.

To lock someone out:

1. Under **Workspace key**, type a passphrase for a new key backup, then **Rotate the key**.
2. Download the new key backup, then **Finish rotation**.
3. Choose **New invite** for every remaining user and send each one their file.

Each person then chooses **Open a new invite** in the app. Their old passport stops working once the key has been rotated.

## Troubleshooting

### "That passphrase does not open this file."

The passphrase is wrong for this file. An invite opens with the one-time passphrase the admin chose. A passport opens with the person's own.

### "This is an invite file, not a passport file."

The wrong file was picked. Choose **I have an invite** for an invite and **I have a passport** for a passport.

### "Your passport is out of date. Ask the admin for a new invite."

The workspace key was rotated after the passport was made. The admin sends a new invite, and the person opens it with **Open a new invite**.

### "This passport is for a different workspace."

The passport belongs to another shared folder. Choose the folder it was made for, or ask that folder's admin for an invite.

### "The admin page is already open in another tab."

One admin page at a time can work on a folder from one browser. Use the other tab, or close it and try again.

## Next steps

- [Back up and restore](back-up-and-restore.md)
- [Keys and identity](../explanation/keys-and-identity.md)
