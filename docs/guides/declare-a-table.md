# Declare a table and field rules

A table is a set of records of one kind, like a database table. You declare every table in `app/app.config.ts`, and nowhere else.

**You will learn**

- How to add a table
- How to choose a kind for each field
- What a row looks like when a screen reads it

## Add the table

Add an entry under `tables`, with a `version` and its `fields`:

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
    meetings: {
      version: 1,
      fields: {
        subject: { kind: "latest", type: "string" },
        room: { kind: "ask", type: "string" },
        seats: { kind: "latest", type: "number" },
        agenda: "text",
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

Start every table at `version: 1`. You raise it when the table's shape changes. See [Add a migration](add-a-migration.md).

The app checks the definition when it starts and stops with a message if a name breaks a rule:

- A table name uses letters, digits and hyphens. `users` is taken: the framework keeps its own table of that name.
- A field name starts with a letter and uses letters, digits and `_`. `id` and `deleted` are taken.

## Choose a kind for each field

The kind decides what happens when two people change the same field before either has seen the other's change.

| Kind | Result | Value type |
|---|---|---|
| `latest` | One value wins, the same one on every computer. | `string`, `number` or `boolean` |
| `ask` | Both values are kept. The field is in conflict until a person picks one. | `string`, `number` or `boolean` |
| `text` | The two edits are merged, character by character. | always `string` |

Write a `latest` or `ask` field as `{ kind, type }`. Write a text field as `"text"`.

Use `ask` sparingly. Every conflict is a question someone has to answer, so keep it for fields where a silent wrong value does harm: a time, a room, a name. Use `latest` for ticks, labels and anything low-stakes.

> **Note**
>
> You can write a `latest` or `ask` field as the bare string, `"latest"` or `"ask"`. Its value is then not checked, and screens read it as `unknown`. Give the field a type unless you have a reason not to.

## Read a row

Screens get rows from the [data hooks](read-with-hooks.md). A row has the fields you declared, plus three the framework adds:

```tsx
import { useRecords, type RowOf } from "@trellis/framework";

function MeetingLine({ meeting }: { meeting: RowOf<"meetings"> }) {
  const inConflict = meeting._conflicts.room !== undefined;
  return (
    <li>
      {meeting.subject ?? "Untitled"} in {meeting.room ?? "no room yet"}
      {inConflict && " (needs a decision)"}
    </li>
  );
}

export function MeetingList() {
  const meetings = useRecords("meetings");
  return <ul>{meetings.map((meeting) => <MeetingLine key={meeting.id} meeting={meeting} />)}</ul>;
}
```

| Field | What it is |
|---|---|
| `id` | The record's id. |
| `_deleted` | `true` once the record is removed. Removed records are kept, so they can be restored. |
| `_conflicts` | For each `ask` field in conflict, the values waiting for a decision. |

Every field you declared is optional on the row, and a typed field cannot be set back to nothing. To clear a string, set it to `""`. A number field accepts any number, `NaN` included, so check what an input gives you before you write it. Tables sync independently and records arrive in pieces, so a screen has to cope with a field that is not there yet.

> **Pitfall**
>
> Do not keep a list inside a field. If two people add to it at once, one addition is lost. Make each entry its own record, in its own table, with a field that holds the parent's id.

## Next steps

- [Read with hooks](read-with-hooks.md)
- [Handle a conflict](handle-a-conflict.md)
- [`app.config.ts` reference](../reference/app-config.md)
