# Add a migration

A migration updates records written by an earlier version of your app. You add one when a table's shape changes, for example when a new field needs a starting value.

**You will learn**

- How to raise a table's version
- How to write a migration step
- What people on the old version see

## Raise the version and add a step

Raise the table's `version` by one, and add a step under `migrations`, keyed by the version it starts from:

```ts
// app/app.config.ts
import type { AppDefinition } from "@trellis/framework";

const config = {
  id: "my-app",
  name: "My App",
  tables: {
    items: {
      version: 2,
      fields: {
        title: { kind: "latest", type: "string" },
        done: { kind: "latest", type: "boolean" },
        notes: "text",
        owner: { kind: "ask", type: "string" },
        priority: { kind: "latest", type: "string" },
      },
    },
  },
  migrations: {
    items: {
      1: (record) => ({ ...record, priority: record.priority ?? "normal" }),
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

The step keyed `1` takes a record's fields from version 1 to version 2. A table at version 3 has steps `1` and `2`, and a record written at version 1 goes through both.

Write every step so that:

- **It only adds.** Give a new field a value. Do not remove or rename a field: computers still on the old version are writing it.
- **Running it twice changes nothing.** `record.priority ?? "normal"` leaves a record that already has a priority alone.

A step runs on one record at a time, as the record is read. The migrated fields are stored the next time a command writes that record.

## Release it

Ship the new version as usual. See [Cut a signed release](release.md). Each person gets the new table shape when they load the new version.

## What the old version sees

Once any computer has written the table at version 2, a computer still running version 1 can read the table but not write to it. A command on it returns:

```ts
import type { CommandResult } from "@trellis/framework";

export const refused: CommandResult = {
  ok: false,
  code: "schema-too-new",
  error: "items: this app is older than the data; load the new version (stored at schema version 2, this app supports 1); nothing was written",
};
```

Nothing is written, so the old version cannot damage the new data. Other tables keep working. The message is exported as `OLDER_APP_MESSAGE`, for a screen that wants to recognise it.

## Troubleshooting

### "Migrations for items: version 2 must be a whole number of 1 or more, below the table's version (2)"

A step's key is the version it starts from, so the highest key is one less than the table's `version`. Raise the version, or move the step to key `1`.

### "Migrations name table item, which is not declared in tables"

The name under `migrations` does not match a table. Check the spelling.

## Next steps

- [`app.config.ts` reference](../reference/app-config.md#migrations)
- [Back up and restore](back-up-and-restore.md), before a change you are unsure of
