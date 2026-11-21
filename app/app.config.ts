import type { AppDefinition } from "@trellis/framework";

const config = {
  id: "trellis-example",
  name: "Trellis Example",
  tables: { scratch: { version: 1, fields: {} } },
} satisfies AppDefinition;

export default config;

// Row types are inferred from this definition (spec S2).
declare module "@trellis/framework" {
  interface Register {
    config: typeof config;
  }
}
