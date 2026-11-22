# Signed updates

The app's code travels through the same shared folder as its data. That is convenient, and it is a risk: anyone who can write to the folder could put code there. Signing is what makes it safe. This page explains what is signed, who checks it, and why releases are built the way they are.

## Two files: a small page and the app

A person opens one HTML file, `<id>.html`. It is small and holds almost none of the app. Its job is to find the app's code, check it, and run it.

The app itself is one JavaScript file per version, `app/<id>-<version>.js`, in the shared folder.

They are separate because a page opened from disk cannot be replaced from inside. If the whole app were in that file, every update would mean handing everyone a new file. With the split, the small page stays the same and only the app file changes.

## The manifest

`app/manifest.json` says which version is current. It lists every released version with the name of its file and a hash of its contents. The whole manifest is signed with the admin's signing key.

The small page has the matching public key built into it. On each check it:

1. Reads the manifest and verifies the signature.
2. Reads the app file the manifest names and checks its hash.
3. Stores the file in the browser.

A release that fails any step is ignored, with a message, and the version already stored keeps running. Code that the admin did not sign never runs.

## What the checks rule out

| Attack or accident | What stops it |
|---|---|
| Someone edits an app file in the folder. | Its hash no longer matches the manifest. |
| Someone writes their own manifest. | It is not signed with the admin's key. |
| Someone puts an old, signed manifest back, to return people to a version with a known fault. | Each manifest has a serial number, and a browser refuses one lower than it has already accepted. |
| The sync tool delivers half a file. | The hash or the signature fails. The check runs again later. |

The public key cannot be changed by a release, because it lives in the page the person opens, not in the folder's `app/`. Replacing the key means handing out a new page.

## Updates are offered, not forced

The app checks the folder when it starts and every 15 minutes after. A new version is verified and stored in the background, and the app then shows that it is ready. It runs the next time the page loads: when the person chooses **Load it**, or when they next open the app.

Nobody's work is interrupted by an update, and the app starts from the browser's stored copy, so it opens even when the folder is out of reach.

## Versions are written once

A version's file is never changed after release. That rule is what makes two things work:

- **History.** Each manifest lists the earlier versions again, so the folder always describes every version in it.
- **Rollback.** Going back a version needs no build. It is a new signed manifest, with a higher serial, that points at a version already in the folder. See [Roll back a release](../guides/roll-back.md).

Each browser also keeps the last two versions it verified, so one person can run the previous version by opening the page with `#previous`.

## Where the signing key lives

`npm run keygen` makes the pair. The public half is built into the page. The signing half is a secret in the project's GitHub repository, and the release workflow is the only thing that uses it.

That makes the repository, and the people who can push a tag to it, the root of trust. Anyone who can make a release there can ship code to every colleague. Guard it the way you would guard the folder's data.

## Related

- [Cut a signed release](../guides/release.md)
- [Every update message](../reference/messages.md#updates)
- [Known limits](limits.md)
