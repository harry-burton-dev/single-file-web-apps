# Quickstart

An app made with this framework runs from a shared folder (OneDrive, Dropbox, a network drive) with no server. You describe its tables in one file and write React screens. Sync, encryption, sign-in by invite, signed updates and the app shell are already done.

You need Node 22.18 or later, git, and Chrome or Edge (the app uses the browser's folder access, which other browsers lack).

You only edit `app/`. Everything under `framework/`, `masters/` and `.github/` belongs to the framework: leave it as it is.

## 1. Create a project

If you were given a project that already exists, its last commit is your starting point: skip to the key step below.

From a clone of the framework repository:

```sh
npm ci
npm run create -- my-app
cd ../my-app
```

`create` copies the framework into a new folder beside the clone (use `--dir <parent>` to put it elsewhere), names it `my-app`, starts a fresh git repository with no commits, installs, and runs the project's checks once. The name is lower-case letters, digits and single hyphens.

Make the first commit, so that `git diff` shows your own changes from here on:

```sh
git add -A
git commit -m "Create my-app"
```

The project has its own checks. They need a public signing key to build the app; any key will do for a local check. Set it once in each new terminal, before `npm run ci`, `npm run build` or `npm run two-users`:

```sh
export TRELLIS_PUBLIC_KEY="$(npm run --silent keygen | sed -n 's/^TRELLIS_PUBLIC_KEY=//p')"
npm run ci
```

`npm run ci` installs, typechecks, runs the tests and builds. It is the same script the project's GitHub workflow runs.

Taking later framework fixes is a manual copy in v0.1.0: copy the framework's `framework/` and `masters/` folders over your project's and run `npm run ci`.

## 2. Declare a table

Every table lives in `app/app.config.ts`, the project's one definition file. It also holds the app's `id` and `name`, which name the page title, the local database and the release files. A new project has one example table, `items`:

```ts fragment
tables: {
  items: {
    version: 1,
    fields: {
      title: { kind: "latest", type: "string" },
      done: { kind: "latest", type: "boolean" },
      notes: "text",
      owner: { kind: "ask", type: "string" },
    },
  },
},
```

Add your table next to it. Each field has a kind, which decides what happens when two people change it at the same time:

| Kind | Two edits at once | Use for |
|---|---|---|
| `latest` | the later edit wins | most fields |
| `text` | both edits are merged, character by character | notes, descriptions |
| `ask` | both people are shown both values and one is kept | fields where losing an edit matters |

`latest` and `ask` take a `type` of `"string"`, `"number"` or `"boolean"`, written `{ kind: "latest", type: "number" }`. A bare `"latest"` or `"ask"` is untyped: it accepts any value except `undefined`, and its row type is `unknown`, so prefer a typed field. Every record also has an `id` (a string, made for you) and `deleted`; don't declare fields with those names, or a table called `users`, which the framework keeps for itself.

Table names are letters, digits and hyphens. Start each new table at `version: 1`; it needs no `migrations`. When you later change a table's fields, raise its version and add a step under `migrations` in the same file: `migrations: { items: { 1: (record) => ({ ...record, priority: 0 }) } }` takes `items` records from version 1 to 2.

Row types come from this file, so after a change `npm run typecheck` tells you where a screen uses a field that no longer exists.

## 3. Write a screen

Screens are React components in `app/src/`. They import only from `@trellis/framework`. They read with hooks and write with commands; they never touch files, keys or the folder.

```tsx
// app/src/people-screen.tsx
import { useState, type FormEvent } from "react";
import { Button, useCommand, useRecords } from "@trellis/framework";

export function PeopleScreen() {
  const people = useRecords("people", { sort: "name" });
  const create = useCommand("records.create");
  const update = useCommand("records.update");
  const remove = useCommand("records.remove");
  const [name, setName] = useState("");

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create({ table: "people", fields: { name: name.trim() } });
    setName("");
  };

  return (
    <section id="people" aria-label="People" className="flex flex-col gap-2">
      <form onSubmit={add} className="flex gap-2">
        <input aria-label="New person" className="flex-1 rounded-md border p-2" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit">Add</Button>
      </form>
      <ul>
        {people.map((p) => (
          <li key={p.id} className="flex gap-2">
            <input aria-label="Name" value={p.name ?? ""} onChange={(e) => update({ table: "people", id: p.id, fields: { name: e.target.value } })} />
            <Button variant="outline" onClick={() => remove({ table: "people", id: p.id })}>Remove</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

This assumes a `people` table with a `name` field of kind `latest`, type `string`.

**Reading.** `useRecords(table, query?)` returns the table's rows and re-renders when they change, here or on a colleague's computer. The query takes `where` (an object of field values, or a function) and `sort` (a field name, `{ by, dir: "desc" }`, or a compare function). `useRecord(table, id)` returns one row. `useField(table, id, field)` returns `{ value, conflict }` for one field.

**Writing.** `useCommand(name)` returns a function that runs a command on this computer at once; the change reaches everyone else through the folder. The built-in commands are `records.create` (`{ table, fields }`, returns the new id), `records.update` (`{ table, id, fields }`), `records.remove` and `records.restore` (`{ table, id }`). A command never throws: it returns `{ ok: true, value }` or `{ ok: false, code, error }`. A value of the wrong type, or a field the table doesn't declare, is refused with code `invalid` and nothing is written. Ranges and other rules are up to your screen.

Every kind is written the same way: pass the field's whole new value. For a `text` field, pass the whole new text, as the example does for `notes`; the framework works out what changed and merges it with other people's edits.

A field nobody has set yet is `undefined`, so show it with a default such as `item.owner ?? ""`.

**Conflicts.** When two people set an `ask` field at the same time, the shell shows both values and asks which to keep. The first value set is not a conflict. The screen does nothing for this.

**Showing the screen.** Put it inside `<TrellisApp>` in `app/src/main.tsx`, next to or instead of the example screen:

```tsx fragment
<TrellisApp config={config}>
  <ItemsScreen />
  <PeopleScreen />
</TrellisApp>
```

`TrellisApp` handles everything before your screens appear: choosing the shared folder, accepting an invite, unlocking the user's passport, and the "already open" message. It also shows the health indicator, the diagnostics menu, the update notice, the conflict prompt and the error screen.

Style with Tailwind classes. `Button` and `Badge` come from the framework; colours come from the tokens in `app/src/index.css`.

To see the screen while you work, `npm run dev` opens the app in the browser without the loader.

Then run the checks again:

```sh
npm run ci
```

Its tests include one per table in `app/app.config.ts`: a record one user creates, with a value in every field, must reach a second user through a shared folder. A new table is covered as soon as you declare it, with no test to write.

**The two-user test.** `npm run two-users` builds the app, opens it as two users on one folder in a headless browser, and checks that their edits to the example `items` screen meet. It runs in the project's GitHub workflow. It needs Playwright once: `npm install --no-save playwright && npx playwright install chromium`. It drives the example screen, so keep `items` and `ItemsScreen` while you rely on it. Your own tables are covered by the per-table test in `npm run ci`. Your own screens are checked by the typecheck and the build, not by a browser test: try them with `npm run dev`.

## 4. Invite a user

People get into the app with an invite from the admin. The admin page is a single HTML file opened from disk. Build it with:

```sh
npm run build
```

It is `dist/admin.html` (and every release carries a copy, section 5). Open it in Chrome or Edge, then:

1. **Choose the shared folder.**
2. The first time, **Create the workspace**: type your name and a key backup passphrase, download the key backup, keep it somewhere safe away from the shared folder, then **Finish**. The key backup and its passphrase are the only way back into the admin page.
3. Under **Invite a user**, type the person's name and a one-time passphrase, then **Invite**. An invite file is saved. Send the file to the person and the passphrase separately. Invite yourself too, to use the app.

The person opens the app from the shared folder, chooses the folder, picks **I have an invite**, chooses the file, types the invite's passphrase and a passphrase of their own, and saves their passport on their computer. After that they type their passphrase at each launch.

To remove someone, **Mark inactive**, then **Rotate the key** and give every remaining user a **New invite**.

## 5. Release

A release is a folder that you copy into the shared folder. Everyone's app checks the folder, offers the new version, and loads it only if its signature matches the key built into their copy.

Once per project, make the signing key pair:

```sh
npm run keygen
```

It prints two lines and writes no file. In the project's GitHub repository, store the first value (after `TRELLIS_PUBLIC_KEY=`) as an Actions **variable** named `TRELLIS_PUBLIC_KEY`, and the second as an Actions **secret** named `TRELLIS_SIGNING_KEY`. Keep a backup of the second somewhere safe and never commit it: whoever holds it can ship code to everyone.

Then push a version tag:

```sh
git tag v0.2.0
git push origin v0.2.0
```

The release workflow runs the tests, builds and signs the release, and publishes a GitHub Release with `<id>-<version>.zip`. Unzip it and copy the folder inside into the shared folder, replacing what is there. It holds:

- `<id>.html`: the app. People open this one.
- `<id>-admin.html`: the admin page.
- `app/`: the signed app bundle and its manifest.

The tag sets the version, so you don't edit a version number anywhere.

To build the same folder on your own computer instead, with both keys in the environment: `npm run release`. It writes `dist/release/<name>/`.

To roll back to an earlier version, download the latest release's `manifest.json` and run `npm run release -- --rollback 0.1.0 --previous manifest.json`. It writes only a new `app/manifest.json` that points everyone at 0.1.0; copy it into the shared folder's `app/`.
