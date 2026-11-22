# Write a command

A command is the only way to write. The framework has five built-in commands for single records. You write your own when one action changes several records, or when a write has a rule to check first.

**You will learn**

- How to run a built-in command
- How to define your own
- How a command fails, and what a screen does about it

## Run a built-in command

`useCommand` gives a screen a function that runs the command:

```tsx
import { Button, useCommand } from "@trellis/framework";

export function AddItemButton() {
  const create = useCommand("records.create");
  return <Button onClick={() => create({ table: "items", fields: { title: "New item", done: false } })}>Add</Button>;
}
```

| Command | Input | Does |
|---|---|---|
| `records.create` | `{ table, id?, fields? }` | Creates a record and returns its id. |
| `records.update` | `{ table, id, fields }` | Sets the given fields on a record. |
| `records.remove` | `{ table, id }` | Marks a record deleted. |
| `records.restore` | `{ table, id }` | Brings a deleted record back. |
| `records.resolve` | `{ table, id, field, value }` | Settles an `ask` field to one value. |

## Define your own

Call `defineCommand` once, at the top level of a module. The handler gets a `tx` to read and write with:

```ts
// app/src/commands.ts
import { defineCommand } from "@trellis/framework";

export const completeAll = defineCommand("items.completeAll", (tx) => {
  const open = tx.list("items").filter((item) => !item.done);
  for (const item of open) tx.put("items", item.id, { done: true });
  return open.length;
});

export const claim = defineCommand("items.claim", (tx, input: { id: string }) => {
  if (!tx.get("items", input.id)) tx.fail("That item no longer exists.");
  tx.put("items", input.id, { owner: tx.user });
});
```

A command needs no registering. Importing the module that defines it is enough.

Pass the command itself to `useCommand`. Its input and its return value are typed from the handler:

```tsx
// app/src/complete-all-button.tsx
import { useState } from "react";
import { Button, useCommand } from "@trellis/framework";
import { completeAll } from "./commands";

export function CompleteAllButton() {
  const run = useCommand(completeAll);
  const [message, setMessage] = useState("");

  const onClick = () => {
    const result = run();
    setMessage(result.ok ? `${result.value} completed.` : result.error);
  };

  return (
    <p>
      <Button onClick={onClick}>Complete all</Button> {message}
    </p>
  );
}
```

How a command runs:

- **Reads see the data as it stood when the run began.** `tx.get` and `tx.list` do not see what this run has put. `tx.list` leaves removed records out unless you pass `{ includeDeleted: true }`.
- **Nothing is written until the handler returns.** The framework then checks every change against the table's fields. If one is wrong, none is written.
- **A run is synchronous.** By the time the function returns, this computer has the change and the screens have been told.

Name your commands with your own prefix, such as `items.`. Names that start with `records.` belong to the built-ins, and a name used twice throws when the module loads.

## Give two computers the same id

`records.create` makes a random id. That is right for most records. When two people might create the same thing at once, build the id from its parts with `tx.id`, so both land on one record:

```ts
import { defineCommand } from "@trellis/framework";

export const startDay = defineCommand("items.startDay", (tx, input: { date: string }) => {
  const id = tx.id("day", input.date);
  if (!tx.get("items", id)) tx.put("items", id, { title: `Plan for ${input.date}`, done: false });
  return id;
});
```

## Handle a failure

Running a command never throws. It returns a result, and you check `ok`:

```tsx
import { Button, useCommand } from "@trellis/framework";

export function RemoveButton({ id }: { id: string }) {
  const remove = useCommand("records.remove");

  const onClick = () => {
    const result = remove({ table: "items", id });
    if (!result.ok && result.code === "schema-too-new") window.alert("Load the new version of the app first.");
  };

  return <Button variant="outline" onClick={onClick}>Remove</Button>;
}
```

| `code` | Cause |
|---|---|
| `failed` | The handler called `tx.fail`, or threw. `error` is its message. |
| `invalid` | A change did not fit the table: an unknown field, a value of the wrong type, a write to a deleted record. |
| `schema-too-new` | The table was written by a newer version of the app. This version can read it but not write it. |
| `unknown-command` | No command has that name. |

In every case nothing was written.

## Troubleshooting

### "command name records.x is reserved for built-ins"

Your command's name starts with `records.`. Choose another prefix.

### "command items.x is already defined"

Two `defineCommand` calls use one name, or the module that holds the call is loaded twice. Keep each command in one module and import it from there.

### "items/abc is deleted; restore it before writing to it"

The command wrote to a removed record. Run `records.restore` first, or have the handler call `tx.restore` before `tx.put`.

## Next steps

- [Read with hooks](read-with-hooks.md)
- [`defineCommand` and `Tx` reference](../reference/api.md#definecommand)
