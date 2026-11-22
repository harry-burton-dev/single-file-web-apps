# Quick start

This page takes you from a new project to a second table and a screen that syncs between two people. It takes about fifteen minutes.

An app built on the framework is a page that people open from a shared folder. There is no server. The framework already does sync, encryption, sign-in, updates and the app shell. You describe your tables and write your screens.

**You will learn**

- How to create a project
- How to declare a table and its fields
- How to write a screen that reads with hooks and writes with commands
- How to run the app with a real workspace, and invite a second person
- How to ship a signed release

## Before you start

You need:

- Node 22.18 or later, and git
- Chrome or Edge. The app reads and writes a folder you choose, and other browsers do not allow that.
- A folder to share. To try things out, any empty folder on your computer works. For a team, use a folder that a sync tool such as OneDrive keeps on everyone's computer.

## Create a project

A project is made from a copy of the framework's repository. In that copy, run:

```sh
npm run create -- my-app
```

The name must be lower-case letters, digits and single hyphens. The command writes a new folder, `my-app`, beside the one you ran it in. It sets the app's id to `my-app` and its name to `My App`, starts a fresh git repository, installs the packages, and runs the new project's own checks. It finishes with:

```text
npm run ci passed in /path/to/my-app
```

Add `--dir <folder>` to put the project somewhere else.

Everything from here on happens inside `my-app`. You work in two places:

| Path | What it holds |
|---|---|
| `app/app.config.ts` | The app's id, name, tables and fields. The one definition file. |
| `app/src/` | Your screens and commands. |

The `framework/` folder is the framework itself. You do not edit it, and your code imports only from `@trellis/framework`.

## Declare a table

The project starts with one table, `items`. Add a second one, `contacts`, to `app/app.config.ts`:

```ts
// app/app.config.ts
import type { AppDefinition } from "@trellis/framework";

const config = {
  id: "my-app",
  name: "My App",
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
    contacts: {
      version: 1,
      fields: {
        fullName: { kind: "latest", type: "string" },
        phone: { kind: "ask", type: "string" },
        notes: "text",
      },
    },
  },
} satisfies AppDefinition;

export default config;

declare module "@trellis/framework" {
  interface Register {
    config: typeof config;
  }
}
```

Each field has a kind. The kind says what happens when two people change the field at the same time:

| Kind | When two people edit at once | Use it for |
|---|---|---|
| `latest` | One value wins. | Most fields. |
| `ask` | Both values are kept until someone picks one. | Fields where a silent wrong answer costs something. |
| `text` | The edits are merged, character by character. | Notes and other prose. |

Keep your own `id` and `name` at the top of the file. The `declare module` block at the end is what gives your screens typed rows. Leave it as it is.

> **Pitfall**
>
> Do not call a field `name`. A test in the project fails for any table or field name that the framework's own code also uses as a quoted word, and `name` is one. See [Known limits](explanation/limits.md#names-a-test-rejects).

## Write a screen

A screen is a React component. It reads rows with `useRecords` and writes with `useCommand`. Create `app/src/contacts-screen.tsx`:

```tsx
// app/src/contacts-screen.tsx
import { useState, type FormEvent } from "react";
import { Button, useCommand, useRecords } from "@trellis/framework";

const field = "rounded-md border bg-background p-2 text-sm";

export function ContactsScreen() {
  const contacts = useRecords("contacts", { sort: "fullName" });
  const create = useCommand("records.create");
  const update = useCommand("records.update");
  const [fullName, setFullName] = useState("");

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!fullName.trim()) return;
    create({ table: "contacts", fields: { fullName: fullName.trim() } });
    setFullName("");
  };

  return (
    <section aria-label="Contacts" className="flex flex-col gap-3">
      <form onSubmit={add} className="flex gap-2">
        <input aria-label="New contact" placeholder="New contact" className={`flex-1 ${field}`} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <Button type="submit">Add</Button>
      </form>
      <ul aria-label="Contact list" className="flex flex-col gap-2">
        {contacts.map((contact) => (
          <li key={contact.id} className="flex items-center gap-2">
            <span className="flex-1">{contact.fullName ?? "Unnamed"}</span>
            <input
              aria-label={`Phone for ${contact.fullName ?? "Unnamed"}`}
              placeholder="Phone"
              className={field}
              value={contact.phone ?? ""}
              onChange={(e) => update({ table: "contacts", id: contact.id, fields: { phone: e.target.value } })}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
```

Three things to notice:

- `useRecords("contacts")` returns the table's rows and re-renders the screen when they change, whether the change came from this computer or a colleague's.
- Every field of a row can be `undefined`. Data arrives in pieces, so a screen never assumes a field is there. That is why the name falls back to "Unnamed".
- The screen never saves. A command writes to this computer at once, and the framework saves to the shared folder in the background.

To remove a record, run `records.remove` with `{ table, id }`. [Write a command](guides/write-a-command.md) lists every built-in command.

## Show the screen

The app's entry is `app/src/main.tsx`. Screens are the children of `<TrellisApp>`. Add yours:

```tsx
// app/src/main.tsx
import { mount, TrellisApp } from "@trellis/framework";
import config from "../app.config";
import css from "./index.css?inline";
import { ContactsScreen } from "./contacts-screen";
import { ItemsScreen } from "./items-screen";

export const start = mount(
  <TrellisApp config={config}>
    <ItemsScreen />
    <ContactsScreen />
  </TrellisApp>,
  css,
);
```

`<TrellisApp>` shows everything that comes before your screens: choosing the folder, opening an invite, unlocking. It also shows the sync status, and the prompt that appears when an `ask` field needs a decision.

## Check your work

```sh
npm run typecheck
npm test
```

`typecheck` fails if a screen names a table or field that `app.config.ts` does not declare. `npm test` takes a couple of minutes. It includes a check that your code imports only from `@trellis/framework`.

On Windows, three tests fail that pass on Linux, and `npm test` stops at the first of them. [Known limits](explanation/limits.md#windows) names them and lists the commands to run the rest.

## Run it

Start the development server:

```sh
npm run dev
```

The app opens in your browser and asks for the shared folder, then for an invite. A new folder has no workspace yet, so make one first. That is the admin's job, and it is done on the admin page.

1. Build the admin page. The build needs a signing key, so make one and keep its public half in the project:

   ```sh
   npm run keygen
   ```

   The command prints two lines. Save the JSON after `TRELLIS_PUBLIC_KEY=` as `app/signing-public-key.json`. Keep the second line, the signing key, out of the project. [Cut a signed release](guides/release.md) says where it goes.

   ```sh
   npm run build
   ```

2. Open `dist/admin.html` from disk in Chrome or Edge. Choose your shared folder, then **Create the workspace**. Download the key backup when it is offered and keep it away from the shared folder.
3. Under **Invite a user**, type a one-time passphrase, then use **New invite** on your own row. The invite file is saved to your downloads.
4. Go back to the app. Choose the same folder, then **I have an invite**. Give it the invite file and its passphrase, choose your own passphrase, and save your passport somewhere on your computer, not in the shared folder.

Your screens appear. Add a contact. The badge at the top reads **Saved** once the change has reached the folder.

To see it sync, invite a second person from the admin page, open the app in a second browser profile, and enrol there with their invite. A contact added in one profile appears in the other, usually within a minute. Give both profiles a different phone number for the same contact while neither has seen the other's change, and the app shows **1 needs a decision**.

## Ship it

A release is a signed zip that you copy into the shared folder. Your colleagues open one HTML file from that folder, and later releases reach them through the folder too.

1. In the project's GitHub repository, store the `TRELLIS_PUBLIC_KEY` line as an Actions variable and the `TRELLIS_SIGNING_KEY` line as an Actions secret.
2. Push a tag:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. Download `my-app-0.1.0.zip` from the GitHub Release the workflow publishes, and copy what is inside its `My App` folder into the shared folder.

[Cut a signed release](guides/release.md) has the details.

## Troubleshooting

### `create` stops with "step "npm install" failed (exit Error: spawnSync npm ENOENT)"

This happens on Windows. The project folder is complete by then. Change into it and run `npm install` yourself. See [Known limits](explanation/limits.md#windows).

### "The bootstrap needs the admin's public signing key"

`npm run build` found no key. Set `TRELLIS_PUBLIC_KEY` or add `app/signing-public-key.json`, as in [Run it](#run-it).

### "This folder has no workspace yet. Ask the admin to create one."

The folder you chose has no `workspace.json`. Create the workspace on the admin page first, or choose the folder that has one.

### `npm test` fails with "the example app is under 150 non-blank lines"

The project keeps a test that was written for the example app. It counts the lines under `app/src` and expects the `items` table and its screen. The limit is 150 non-blank lines, and the example uses 80, so a second screen fits and a third may not. Delete `framework/test/app-size.test.js` once the test fails for that reason, not before. It is an exception to the rule that you leave `framework/` alone. See [Known limits](explanation/limits.md#the-example-apps-size-test).

### `npm test` fails with "no table or field name from app.config.ts is quoted in framework source"

One of your table or field names is also a quoted word in the framework's code. The failure lists the names. Rename them. See [Known limits](explanation/limits.md#names-a-test-rejects).

## Next steps

- [Declare a table and field rules](guides/declare-a-table.md)
- [Write a command](guides/write-a-command.md), for writes that touch more than one record
- [Handle a conflict](guides/handle-a-conflict.md)
- [How sync works](explanation/sync.md)
- [API reference](reference/api.md)
