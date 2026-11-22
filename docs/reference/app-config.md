# `app.config.ts` reference

`app/app.config.ts` is the app's one definition file. Its default export names the app and declares every table. The page title, the browser database, the file names of a release and the row types of every hook all come from it.

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
  },
} satisfies AppDefinition;

export default config;

declare module "@trellis/framework" {
  interface Register {
    config: typeof config;
  }
}
```

The definition is checked when the app starts. Each rule below gives the message the app stops with when the rule is broken.

## `id`

The app's id. Lower-case letters, digits and single hyphens.

It names things people do not read: the browser database, the folder picker, and the files of a release.

| From the id `my-app` | Name |
|---|---|
| The page people open | `my-app.html` |
| The admin page | `my-app-admin.html` |
| The app file for version 0.2.0 | `my-app-0.2.0.js` |
| The release zip for version 0.2.0 | `my-app-0.2.0.zip` |
| The browser database | `my-app` |

> **Pitfall**
>
> Do not change the id once people use the app. Each browser keeps its local data and its remembered folder under the id, so a new id starts every browser from nothing.

Message: `App id "My App" must be lower-case letters, digits and single hyphens`

## `name`

The app's name, as people read it. It is the page title and the name of the release folder. It must not be empty.

Message: `App name must be a non-empty string`

## `tables`

An object with one entry per table. The key is the table's name.

A table name uses letters, digits and hyphens, and starts with a letter or digit. The name `users`, in any mix of upper and lower case, is reserved for the framework's own table.

Messages:

- `Table name "my table" must be letters, digits and hyphens, starting with a letter or digit`
- `Table name "Users" is reserved: the framework keeps its own users table`

A folder can hold tables that the definition does not name. The app never opens them, so it leaves them as they are.

### `version`

A whole number, 1 or more. Raise it by one when the table's shape changes, and add a [migration](#migrations).

Message: `Table items: version must be a whole number of 1 or more`

### `fields`

An object with one entry per field. The key is the field's name, and the value is one of:

| Value | Kind | Row type |
|---|---|---|
| `{ kind: "latest", type: "string" }` | `latest` | `string` |
| `{ kind: "latest", type: "number" }` | `latest` | `number` |
| `{ kind: "latest", type: "boolean" }` | `latest` | `boolean` |
| `{ kind: "ask", type: ... }` | `ask` | as for `latest` |
| `"text"` or `{ kind: "text" }` | `text` | `string` |
| `"latest"` or `"ask"` | as named | `unknown`, and writes are not checked |

A field name starts with a letter and uses letters, digits and `_`. `id` and `deleted` are reserved.

Messages:

- `Table items: field name "_x" must start with a letter, use letters, digits and _, and not be id or deleted`
- `Table items: field owner must be "latest", "ask", "text", { kind: "text" } or { kind: "latest" | "ask", type: "string" | "number" | "boolean" }`

`fields` is optional. A table with no fields holds records that have only an id.

## `migrations`

Optional. An object keyed by table name. Each value is an object keyed by the version a step starts from:

```ts
// app/app.config.ts
import type { AppDefinition } from "@trellis/framework";

const config = {
  id: "my-app",
  name: "My App",
  tables: {
    items: {
      version: 3,
      fields: {
        title: { kind: "latest", type: "string" },
        done: { kind: "latest", type: "boolean" },
        notes: "text",
        owner: { kind: "ask", type: "string" },
        priority: { kind: "latest", type: "string" },
        estimate: { kind: "latest", type: "number" },
      },
    },
  },
  migrations: {
    items: {
      1: (record) => ({ ...record, priority: record.priority ?? "normal" }),
      2: (record) => ({ ...record, estimate: record.estimate ?? 1 }),
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

A step takes a record's fields and returns them one version on. Steps should only add fields, and should leave an already-migrated record unchanged. [Add a migration](../guides/add-a-migration.md) says why.

Messages:

- `Migrations name table item, which is not declared in tables`
- `Migrations for items: version 3 must be a whole number of 1 or more, below the table's version (3)`
- `Migrations for items: the step from version 1 must be a function`

## The `declare module` block

The block at the end of the file registers the definition's type. It is what makes `useRecords("items")` return typed rows, and what makes a wrong table or field name a type error.

Without it the app still runs. Every table name is then accepted by the type checker, and every field reads as `unknown`.

## What else reads this file

- `npm run build` and `npm run release` read the id and name for file names and the page title.
- The admin page is built with the whole definition, so that it can back up every table.
- `npm run create` sets `id` and `name` in a new project. It expects each on its own line, in the form `id: "...",`.
