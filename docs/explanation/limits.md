# Known limits

What the framework does not do, and what has not been proven. Read this before you rely on it for something that matters.

## Not yet proven

- **A real synced folder on a work computer.** The automated tests run two users against a stand-in folder, from built files opened from disk. The app has not been proven against real OneDrive on a managed laptop. An organisation's browser policy can switch off folder access altogether.
- **Files that are online-only.** Sync tools can leave a file in the cloud until it is opened. How the app behaves with those has not been tested. Set the shared folder to always be kept on the device.

## Browser

- **Chrome and Edge only.** The app reads and writes a folder through an API that other browsers do not offer.
- **One tab at a time.** One browser profile can have the app open in one tab. A second tab says the app is already open.
- **Pages opened from disk share storage.** Another HTML file opened from disk in the same browser profile may be able to read what the app has stored there.

## Sync

- **Not instant.** A change reaches a colleague in about a minute, plus the sync tool's own delay.
- **Removed content lingers.** A removed record's contents stay in older files in the folder, and in the sync tool's version history, until those files are replaced.
- **An open conflict stays open.** An `ask` field in conflict waits until a person decides. Nothing times out.

## People and permissions

- **Everyone invited can read and write everything.** There are no per-table or per-record permissions.
- **Roles are labels.** A user's role, `admin` or `member`, is recorded but does not restrict anything in the app.
- **Removing someone needs a key rotation**, and a new invite for every remaining user. Data they could already read stays readable to them if they kept a copy.
- **A lost key cannot be recovered.** If the key backup and every passport are lost, so is the data.

## Releases and upgrades

- **The signing key lives in GitHub.** Whoever can push a tag to the project's repository can ship code to every colleague.
- **One release channel.** Every user gets the same version. There is no beta channel.
- **No plugins.**
- **Framework fixes are copied by hand.** A project keeps its own copy of the `framework/` and `masters/` folders. To take a later fix, copy both from a newer version of the framework's repository over your project's, then run `npm run ci`.
- **No scheduled backups.** A backup exists only when the admin makes one.

## Windows

The development scripts are tested on Linux, which is what the CI workflow runs. On Windows:

- `npm run create` stops at its install step with `spawnSync npm ENOENT`. The new project's files are all written by then. Run `npm install` in the new folder yourself.
- `npm run release` stops when it starts the build, for the same reason. The rollback form, `npm run release -- --rollback`, builds nothing and works.
- Three tests fail because of how they handle Windows file paths. They pass on Linux.

  | Test | What you see |
  |---|---|
  | `framework/runtime/test/build-names.test.js`: "a build through the Vite factory uses the given definition's names" | `the bundle does not contain <your app id>` |
  | `framework/test/no-test-key.test.js`: "finds the old seed or helper name anywhere under the folder, and nothing in a clean one" | `app\b.js` where `app/b.js` was expected |
  | `framework/test/no-test-key.test.js`: "the app source no longer holds the test key" | `ENOENT ... scandir 'C:\C:\...'` |

- `npm test` runs five suites one after another and stops at the first that fails. On Windows that is the second, so the last three never run. Run them one at a time:

  ```sh
  node --test "framework/engine/test/**/*.test.js"
  node --test "framework/runtime/test/**/*.test.js"
  node --test "framework/data/test/**/*.test.js"
  node --test "framework/test/*.test.js"
  npm run test:shell
  ```

  Any failure other than the three above is a real one.

`npm run dev`, `npm run typecheck` and `npm run build` work on Windows. Releases are meant to be made by the workflow, which runs on Linux.

## Related

- [How sync works](sync.md)
- [Keys and identity](keys-and-identity.md)
- [Signed updates](signed-updates.md)
