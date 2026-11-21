// Test content: one shared note, read with hooks and written with commands.
// The example app (OUT-39) replaces it.
import { Button, useCommand, useConflicts, useRecord, useResolveConflict } from "@trellis/framework";

const NOTE = "note";
const input = "rounded-md border p-2 text-sm";

export function NoteScreen() {
  const note = useRecord("memos", NOTE);
  const create = useCommand("records.create");
  const update = useCommand("records.update");
  const conflicts = useConflicts();
  const resolve = useResolveConflict();

  // The first edit on any device creates the note; later edits update it.
  const save = (fields: { subject?: string; venue?: string; details?: string }) =>
    note ? update({ table: "memos", id: NOTE, fields }) : create({ table: "memos", id: NOTE, fields });

  return (
    <section aria-label="Shared test note" className="flex flex-col gap-2">
      <input id="note-subject" aria-label="Subject" className={input} placeholder="Subject" value={note?.subject ?? ""} onChange={(e) => save({ subject: e.target.value })} />
      <input id="note-venue" aria-label="Venue" className={input} placeholder="Venue" value={note?.venue ?? ""} onChange={(e) => save({ venue: e.target.value })} />
      {conflicts.map((c) => (
        <div key={`${c.table}/${c.id}/${c.field}`} role="group" aria-label={`Choose the ${c.field}`} className="flex flex-wrap items-center gap-2 text-sm">
          <span>Edited on two devices. Keep:</span>
          {c.candidates.map((candidate) => (
            <Button key={candidate.device} size="sm" variant="outline" onClick={() => resolve(c, candidate.value)}>
              {String(candidate.value)}
            </Button>
          ))}
        </div>
      ))}
      <textarea id="note" aria-label="Shared test note" className={`min-h-32 ${input}`} placeholder="Shared test note" value={note?.details ?? ""} onChange={(e) => save({ details: e.target.value })} />
    </section>
  );
}
