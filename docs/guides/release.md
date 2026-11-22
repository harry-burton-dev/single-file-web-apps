# Cut a signed release

A release is a folder of files that you copy into the shared folder. Its manifest is signed, and every colleague's copy of the app refuses a release that is not signed with your key.

**You will learn**

- How to make the signing key and where each half goes
- How to publish a release by pushing a tag
- How the release reaches your colleagues

## Make the signing key, once

Run:

```sh
npm run keygen
```

It prints two lines:

```text
TRELLIS_PUBLIC_KEY={"key_ops":["verify"],"ext":true,"kty":"EC","x":"...","y":"...","crv":"P-256"}
TRELLIS_SIGNING_KEY={"key_ops":["sign"],"ext":true,"kty":"EC","x":"...","y":"...","crv":"P-256","d":"..."}
```

In the project's GitHub repository, under the Actions settings:

- Store the JSON after `TRELLIS_PUBLIC_KEY=` as a **variable** named `TRELLIS_PUBLIC_KEY`.
- Store the JSON after `TRELLIS_SIGNING_KEY=` as a **secret** named `TRELLIS_SIGNING_KEY`.

Keep a copy of the signing key somewhere safe and never commit it.

> **Pitfall**
>
> Whoever holds the signing key can ship code to every colleague. If you lose it, you cannot release again without handing everyone a new copy of the app's HTML file.

## Publish a release

Push a tag that starts with `v`:

```sh
git tag v0.2.0
git push origin v0.2.0
```

The release workflow sets the app's version from the tag, runs the tests, builds, signs, and publishes a GitHub Release with two files:

| File | What it is |
|---|---|
| `<id>-0.2.0.zip` | The release folder, zipped. |
| `manifest.json` | The signed manifest on its own. The next release reads it, so it can list this version again. |

Inside the zip is one folder, named after your app:

```text
My App/
  my-app.html           the page people open
  my-app-admin.html     the admin page
  app/
    my-app-0.2.0.js     the app, as one file
    manifest.json       signed: says which version is current
```

## Put it in the shared folder

Copy what is inside the zip's folder into the shared folder. `app/` goes beside `data/`, and the new files go in beside the old ones.

- **The first release.** Tell your colleagues to open `my-app.html` from the shared folder in Chrome or Edge. They connect the folder once, and the page loads the app from it.
- **Later releases.** People do nothing. The app checks the folder for a new version when it starts and every 15 minutes after that. When one is there, it shows **Version 0.2.0 is ready.** with a **Load it** button.

Never replace or delete a file under `app/` that an earlier release put there. A file for a version is written once. To change the code, release a new version.

## Build a release on your own computer

To see what a release holds without pushing a tag, set both keys in your shell and run:

```sh
npm run release
```

The folder is written to `dist/release/`. The version comes from `app/package.json`. Pass `--previous <manifest.json>` with the last release's manifest so that the new manifest still lists the earlier versions.

## Troubleshooting

### "TRELLIS_SIGNING_KEY is not set. Create a key pair with: npm run keygen"

The release step found no key. In the workflow, check the variable and the secret. On your own computer, set both in the shell.

### "Version 0.2.0 was already released with a different bundle."

The version in the tag has been released before with other code. Use the next version number.

### "A new version was not installed. The release manifest is not signed by this app's admin. It was ignored."

The manifest in the shared folder was signed with a different key from the one built into the HTML file people open. Release again with the right key. Everyone keeps running the version they have.

### "A new version was not installed. Version 0.2.0 in the folder does not match the release manifest. It may still be syncing."

The app file is not fully in the folder yet. The check runs again by itself.

## Next steps

- [Roll back a release](roll-back.md)
- [Signed updates](../explanation/signed-updates.md)
- [Every update message](../reference/messages.md#updates)
