import type { AppDefinition } from "@trellis/framework";

const config = {
  id: "my-app",
  name: "My App",
  tables: {
    // One of each field kind (spec S2): last write wins, merged text, ask on conflict.
    items: {
      version: 1,
      fields: {
        title: { kind: "latest", type: "string" },
        done: { kind: "latest", type: "boolean" },
        notes: "text",
        owner: { kind: "ask", type: "string" },
      },
    },
    // The table the quickstart's screen assumes.
    people: {
      version: 1,
      fields: {
        name: { kind: "latest", type: "string" },
      },
    },
  },
} satisfies AppDefinition;

export default config;

// Row types are inferred from this definition (spec S2).
declare module "@trellis/framework" {
  interface Register {
    config: typeof config;
  }
}
