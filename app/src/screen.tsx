// Engine test screen: one shared note.
import { useSharedText, type Engine } from "@trellis/framework";

const TABLE = "scratch";

export function Screen({ engine }: { engine: Engine }) {
  const map = engine.table(TABLE).getMap("note");
  const text = useSharedText(map, "text");
  return (
    <textarea
      id="note"
      className="min-h-32 rounded-md border p-2 text-sm"
      placeholder="Shared test note"
      value={text}
      onChange={(event) => map.set("text", event.target.value)}
    />
  );
}
