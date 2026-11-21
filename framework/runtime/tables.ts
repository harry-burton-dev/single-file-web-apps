// The engine's table list for an app config: every table syncs through Yjs.
import type { AppConfig } from "../config.ts";

export function engineTables(config: Pick<AppConfig, "tables">): Record<string, "yjs"> {
  return Object.fromEntries(Object.keys(config.tables).map((name) => [name, "yjs" as const]));
}
