import type { AppConfig } from "@trellis/framework";

export default {
  id: "example",
  name: "Example",
  tables: { scratch: { version: 1, fields: {} } },
} as const satisfies AppConfig;
