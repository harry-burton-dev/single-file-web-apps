// Type tests for inferred row types (spec S2, "typed results by inference").
// Checked by `npm run typecheck`; never run.
import type { AppDefinition } from "../../runtime/definition.ts";
import type { Candidate, ConfigOf, Fields, Row, ValueOf } from "../schema.ts";

const config = {
  id: "notes-app",
  name: "Notes",
  tables: {
    notes: { version: 1, fields: { title: { kind: "latest", type: "string" }, room: { kind: "ask", type: "number" }, body: { kind: "text" }, done: { kind: "latest", type: "boolean" } } },
    tags: { version: 1, fields: { label: "latest", owner: "ask", note: "text" } },
    empty: { version: 1 },
  },
} satisfies AppDefinition;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(_: T) => {};

// The app's Register augmentation resolves to its config; an empty Register falls back to any definition.
type Registered = ConfigOf<{ config: typeof config }>;
expect<Equal<Registered, typeof config>>(true);
expect<Equal<ConfigOf<{}>, AppDefinition>>(true);
// @ts-expect-error a wrong table name
type _NoTable = Registered["tables"]["nope"];

type Note = Row<Registered["tables"]["notes"]>;
type Tag = Row<Registered["tables"]["tags"]>;
declare const note: Note;
declare const tag: Tag;

expect<Equal<typeof note.id, string>>(true);
expect<Equal<typeof note._deleted, boolean>>(true);
expect<Equal<typeof note.title, string | undefined>>(true);
expect<Equal<typeof note.room, number | undefined>>(true);
expect<Equal<typeof note.body, string | undefined>>(true);
expect<Equal<typeof note.done, boolean | undefined>>(true);
expect<Equal<typeof note._conflicts.room, readonly Candidate<number>[] | undefined>>(true);
// @ts-expect-error only ask fields have conflicts
note._conflicts.title;
// @ts-expect-error a wrong field
note.nope;
// @ts-expect-error rows are read-only
note.title = "x";

expect<Equal<typeof tag.label, unknown>>(true);
expect<Equal<typeof tag.note, string | undefined>>(true);
expect<Equal<typeof tag._conflicts.owner, readonly Candidate<unknown>[] | undefined>>(true);

declare const empty: Row<Registered["tables"]["empty"]>;
expect<Equal<keyof typeof empty, "id" | "_deleted" | "_conflicts">>(true);

const write: Fields<Registered["tables"]["notes"]> = { title: "a", room: 2 };
// @ts-expect-error a wrong value type
const badType: Fields<Registered["tables"]["notes"]> = { title: 1 };
// @ts-expect-error a wrong field
const badField: Fields<Registered["tables"]["notes"]> = { nope: 1 };
expect<Equal<ValueOf<"text">, string>>(true);
void [write, badType, badField];
