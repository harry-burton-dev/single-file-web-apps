# Roll back a release

A rollback points everyone back at an earlier version. It builds nothing: it writes a new signed manifest that names a version already in the shared folder.

**You will learn**

- How to write a rollback manifest
- How one person can run the previous version without a rollback

## Roll everyone back

You need both keys in your shell, and the current manifest. The current manifest is `app/manifest.json` in the shared folder.

1. Copy `app/manifest.json` from the shared folder to your computer.
2. Run the release script with the version to go back to:

   ```sh
   npm run release -- --rollback 0.1.0 --previous ./manifest.json
   ```

   It prints what the current manifest lists, then where it wrote the new one:

   ```text
   previous manifest: serial 1795352441, versions 0.1.0, 0.2.0
   rollback to 0.1.0 (serial 1795352445) written to dist/release/My App/app/manifest.json. Copy it into the shared folder's app/.
   ```

3. Copy that `manifest.json` over the one in the shared folder's `app/`.

Each person's app picks the manifest up at its next check, within 15 minutes, and offers version 0.1.0 with **Load it**.

A rollback changes the code people run. It does not change data. If the newer version raised a table's version and wrote to it, the older version can read that table but not write to it. See [Add a migration](add-a-migration.md#what-the-old-version-sees).

## Run the previous version on one computer

Each browser keeps the last two versions it has verified. To run the older one, open the app's page with `#previous` at the end of the address:

```text
my-app.html#previous
```

This affects only that browser, and only until the page is opened without `#previous`.

## Troubleshooting

### "A rollback needs the current manifest: --previous &lt;manifest.json&gt;."

Pass the manifest from the shared folder with `--previous`.

### "Version 0.1.0 is not listed in the previous manifest. Listed: 0.2.0."

The manifest does not know that version, so a rollback cannot name it. This happens when a release was built without `--previous`. Release the old code again under a new version number instead.

### "The previous manifest (./manifest.json) was refused"

The file is not signed with the key in `TRELLIS_PUBLIC_KEY`. Check that the keys in your shell are this app's.

### "There is no previous version stored in this browser."

`#previous` was used in a browser that has only ever loaded one version.

## Next steps

- [Cut a signed release](release.md)
- [Signed updates](../explanation/signed-updates.md)
