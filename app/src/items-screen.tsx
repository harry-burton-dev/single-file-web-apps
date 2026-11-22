// The example app's one screen: list the items, add one, edit in place, tick
// done, set the owner. Reads with the data hooks, writes with the built-in commands.
// Conflicts on the owner are shown by the shell, not here.
import { useState, type FormEvent } from "react";
import { Button, useCommand, useRecords, type RowOf } from "@trellis/framework";

const field = "rounded-md border bg-background p-2 text-sm";

export function ItemsScreen() {
  const items = useRecords("items");
  const create = useCommand("records.create");
  const [title, setTitle] = useState("");

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    create({ table: "items", fields: { title: title.trim(), done: false } });
    setTitle("");
  };

  return (
    <section id="items" aria-label="Items" className="flex flex-col gap-3">
      <form id="add-item" onSubmit={add} className="flex gap-2">
        <input id="new-item-title" aria-label="New item" placeholder="New item" className={`flex-1 ${field}`} value={title} onChange={(e) => setTitle(e.target.value)} />
        <Button id="add-item-button" type="submit">Add</Button>
      </form>
      {items.length === 0 && <p className="text-sm text-muted-foreground">No items yet.</p>}
      <ul id="item-list" aria-label="Item list" className="flex flex-col gap-2">
        {items.map((item) => <ItemRow key={item.id} item={item} />)}
      </ul>
    </section>
  );
}

function ItemRow({ item }: { item: RowOf<"items"> }) {
  const update = useCommand("records.update");
  const set = (fields: Partial<Pick<RowOf<"items">, "title" | "done" | "notes" | "owner">>) => update({ table: "items", id: item.id, fields });
  const id = `item-${item.id}`;
  const name = item.title || "Untitled";

  return (
    <li id={id} data-id={item.id} aria-label={name} className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <input id={`${id}-done`} type="checkbox" aria-label={`Done: ${name}`} checked={item.done ?? false} onChange={(e) => set({ done: e.target.checked })} />
        <input id={`${id}-title`} aria-label="Title" className={`flex-1 ${field} ${item.done ? "line-through text-muted-foreground" : ""}`} value={item.title ?? ""} onChange={(e) => set({ title: e.target.value })} />
        <input id={`${id}-owner`} aria-label="Owner" placeholder="Owner" className={`w-32 ${field}`} value={item.owner ?? ""} onChange={(e) => set({ owner: e.target.value })} />
      </div>
      <textarea id={`${id}-notes`} aria-label="Notes" placeholder="Notes" className={`min-h-16 ${field}`} value={item.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} />
    </li>
  );
}
