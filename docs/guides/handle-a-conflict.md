# Handle a conflict

A conflict is an `ask` field that holds more than one value. It happens when two people change the field before either has seen the other's change. The framework keeps both values until a person picks one.

**You will learn**

- What the shell already does for you
- How to show a conflict next to the field itself
- How to list every open conflict

## Let the shell handle it

You do not have to write anything. While any conflict is open, the shell shows a button above your screens: **1 needs a decision**. It opens a list. Each entry names the field, shows every value with who wrote it and when, and has a **Keep** button for each.

Until someone decides, the field has a provisional value: the most recently written one, the same on every computer. Your screens keep working with it.

## Show a conflict at the field

To let people decide where they are looking, read the field with `useField` and settle it with `useResolveConflict`:

```tsx
// app/src/owner-field.tsx
import { Button, useField, useResolveConflict } from "@trellis/framework";

export function OwnerField({ id }: { id: string }) {
  const owner = useField("items", id, "owner");
  const resolve = useResolveConflict();

  if (!owner.conflict) return <span>{owner.value ?? "Nobody"}</span>;

  return (
    <span role="group" aria-label="Choose the owner">
      {owner.conflict.map((candidate) => (
        <Button key={candidate.device} size="sm" variant="outline" onClick={() => resolve({ table: "items", id, field: "owner" }, candidate.value)}>
          Keep {candidate.value} (from {candidate.user})
        </Button>
      ))}
    </span>
  );
}
```

Each candidate has the `value`, the `user` and `device` that wrote it, and `writtenAt`, a time in milliseconds.

Resolving is an ordinary write. It syncs like any other change, and the conflict closes on every computer once it arrives. You can resolve to a value that is none of the candidates.

## List every open conflict

`useConflicts` returns every open conflict on this computer, across all tables:

```tsx
import { useConflicts } from "@trellis/framework";

export function ConflictCount() {
  const conflicts = useConflicts();
  if (conflicts.length === 0) return null;
  return (
    <ul aria-label="Open conflicts">
      {conflicts.map((conflict) => (
        <li key={`${conflict.table}/${conflict.id}/${conflict.field}`}>
          {conflict.field} of {conflict.table} {conflict.id}: {conflict.candidates.length} values
        </li>
      ))}
    </ul>
  );
}
```

The list is sorted by table, id and field. Conflicts on removed records are left out.

## Reword the prompt

The shell's wording is yours to change. Pass `strings` to `<TrellisApp>`:

```tsx
// app/src/main.tsx
import { mount, TrellisApp } from "@trellis/framework";
import config from "../app.config";
import css from "./index.css?inline";
import { ItemsScreen } from "./items-screen";

export const start = mount(
  <TrellisApp
    config={config}
    strings={{
      needsDecision: (count) => `${count} to settle`,
      decisionsTitle: "To settle",
      conflictAbout: (table, id, field) => `The ${field} of a record in ${table}`,
    }}
  >
    <ItemsScreen />
  </TrellisApp>,
  css,
);
```

## Troubleshooting

### "items.title is not an ask field, so it has nothing to resolve"

Only `ask` fields can be in conflict. A `latest` field picks a winner by itself, and a `text` field merges.

### The same conflict comes back after I resolve it

Two people resolved it to different values before either saw the other's choice. That is a new conflict, and it is settled the same way.

## Next steps

- [Declare a table and field rules](declare-a-table.md), to choose which fields are `ask`
- [How sync works](../explanation/sync.md#conflicts)
