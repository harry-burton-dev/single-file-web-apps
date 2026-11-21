import type { AppDefinition } from "@trellis/framework";

export default {
  id: "trellis-example",
  name: "Trellis Example",
  tables: { scratch: { version: 1, fields: {} } },
} satisfies AppDefinition;
