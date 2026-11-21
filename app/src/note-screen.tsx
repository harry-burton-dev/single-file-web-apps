// Test content: one shared note. The example app (OUT-39) replaces it.
import { useEngine } from "@trellis/framework";
import { useSharedText } from "./use-engine";

export function NoteScreen() {
  const map = useEngine().table("scratch").getMap("note");
  const text = useSharedText(map, "text");
  return (
    <textarea
      id="note"
      aria-label="Shared test note"
      className="min-h-32 rounded-md border p-2 text-sm"
      placeholder="Shared test note"
      value={text}
      onChange={(event) => map.set("text", event.target.value)}
    />
  );
}
