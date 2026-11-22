# Read with hooks

A screen reads data with hooks. Each hook subscribes to one table, and the screen re-renders when its own result changes: after a command on this computer, or when a colleague's change arrives from the folder.

**You will learn**

- How to list, filter and sort a table's rows
- How to read one record, or one field
- How to show the sync status

## List a table's rows

`useRecords` returns the rows of a table. Removed records are left out:

```tsx
import { useRecords } from "@trellis/framework";

export function ItemTitles() {
  const items = useRecords("items");
  return <ul>{items.map((item) => <li key={item.id}>{item.title ?? "Untitled"}</li>)}</ul>;
}
```

## Filter and sort

Pass a query as the second argument:

```tsx
import { useRecords } from "@trellis/framework";

export function OpenItems({ owner }: { owner: string }) {
  const mine = useRecords("items", { where: { owner, done: false }, sort: "title" });
  const longNotes = useRecords("items", {
    where: (item) => (item.notes ?? "").length > 200,
    sort: { by: "title", dir: "desc" },
  });

  return (
    <p>
      {mine.length} open for {owner}. {longNotes.length} with long notes.
    </p>
  );
}
```

- `where` as an object matches rows whose fields equal every value given. As a function, it is a filter.
- `sort` is a field name, `{ by, dir }`, or a compare function. Rows with no value for the field sort last.
- `includeDeleted: true` adds removed records to the result.

> **Pitfall**
>
> `where: { done: false }` does not match a row whose `done` was never set. A missing field is `undefined`, not `false`. Set the field when you create the record, or filter with a function: `where: (item) => !item.done`.

## Read one record

`useRecord` returns one record by id, or `undefined` when there is none. It returns removed records too, so check `_deleted`:

```tsx
import { useRecord } from "@trellis/framework";

export function ItemTitle({ id }: { id: string }) {
  const item = useRecord("items", id);
  if (!item || item._deleted) return <p>This item is gone.</p>;
  return <h2>{item.title ?? "Untitled"}</h2>;
}
```

A record can be missing for a moment even when another record points at it. Tables sync independently, so the pointer can arrive first. Show a placeholder and the screen fills in when the record lands.

## Read one field

`useField` returns one field's value and, for an `ask` field, its conflict:

```tsx
import { useField } from "@trellis/framework";

export function Owner({ id }: { id: string }) {
  const owner = useField("items", id, "owner");
  return (
    <span>
      {owner.value ?? "Nobody"}
      {owner.conflict && ` (${owner.conflict.length} values to choose from)`}
    </span>
  );
}
```

A component that uses `useField` re-renders only when that field changes. Use it for a cell in a long list, or for the input of one field.

## Show the sync status

The shell already shows the sync status above your screens. If a screen needs it too, `useHealth` returns the same information:

```tsx
import { useHealth } from "@trellis/framework";

export function UnsavedCount() {
  const health = useHealth();
  if (!health || health.pending === 0) return null;
  return <p>{health.pending} changes waiting to be saved.</p>;
}
```

`useHealth` returns `null` until sync has started.

## Troubleshooting

### "Data hooks must be inside &lt;DataProvider&gt;"

A component that calls a hook was rendered outside `<TrellisApp>`. Put your screens inside it, as `app/src/main.tsx` does.

### "unknown table: contacts"

The table is not in `app/app.config.ts`. With the `declare module` block in place, `npm run typecheck` catches this before the app runs.

## Next steps

- [Write a command](write-a-command.md)
- [Handle a conflict](handle-a-conflict.md)
- [Hooks reference](../reference/api.md#hooks)
