// The conflict prompt (spec S4, Deliver 2; ADR-0002 section 5): while any "ask"
// field holds more than one value, the health area shows a count. The person
// opens it to see each conflict, with who wrote each value and when, and picks
// one. It never opens by itself, so the screens stay usable. Tables and fields
// are named as in the app definition; the shell knows no particular table.
import { useEffect, useId, useState } from "react";
import { useConflicts, useResolveConflict } from "../../react/hooks";
import { useShell } from "./context";
import { clockAndDate } from "./format";
import { Button } from "./ui/button";

export function ConflictPrompt() {
  const { strings } = useShell();
  const conflicts = useConflicts();
  const resolve = useResolveConflict();
  const [open, setOpen] = useState(false);
  const listId = useId();

  useEffect(() => {
    if (conflicts.length === 0) setOpen(false);
  }, [conflicts.length]);
  if (conflicts.length === 0) return null;

  return (
    <div id="conflicts" className="flex flex-col items-start gap-2 text-sm">
      <Button size="sm" variant="outline" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => setOpen(!open)}>
        {strings.needsDecision(conflicts.length)}
      </Button>
      {open && (
        <section id={listId} aria-label={strings.decisionsTitle} className="flex w-full flex-col gap-3 rounded-lg border p-3">
          {conflicts.map((conflict) => {
            const about = strings.conflictAbout(conflict.table, conflict.id, conflict.field);
            return (
              <div key={`${conflict.table}/${conflict.id}/${conflict.field}`} role="group" aria-label={about} className="flex flex-col gap-1">
                <p className="font-medium">{about}</p>
                {conflict.candidates.map((candidate) => (
                  <div key={candidate.device} className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => resolve(conflict, candidate.value)}>
                      {strings.keep(String(candidate.value))}
                    </Button>
                    <span className="text-muted-foreground">{strings.writtenBy(candidate.user, clockAndDate(candidate.writtenAt))}</span>
                  </div>
                ))}
              </div>
            );
          })}
          <Button size="sm" variant="ghost" className="self-start" onClick={() => setOpen(false)}>
            {strings.close}
          </Button>
        </section>
      )}
    </div>
  );
}
