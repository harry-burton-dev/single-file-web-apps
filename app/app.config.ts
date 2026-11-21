import type { AppDefinition } from "@trellis/framework";

const config = {
  id: "trellis-example",
  name: "Trellis Example",
  tables: {
    // One of each field kind (spec S2): last write wins, ask on conflict, merged text.
    // Names framework code never quotes, so the G4 test can tell them apart.
    memos: { version: 1, fields: { subject: { kind: "latest", type: "string" }, venue: { kind: "ask", type: "string" }, details: "text" } },
  },
} satisfies AppDefinition;

export default config;

// Row types are inferred from this definition (spec S2).
declare module "@trellis/framework" {
  interface Register {
    config: typeof config;
  }
}
