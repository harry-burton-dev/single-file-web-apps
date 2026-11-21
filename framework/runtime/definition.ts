// The shape of an app's single definition, app/app.config.ts (spec S1, Deliver 2).

export type TableSchema = {
  version: number;
  fields?: Record<string, "latest" | "ask" | "text">;
};

export type AppDefinition = {
  id: string;
  name: string;
  tables: Record<string, TableSchema>;
};

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function assertAppDefinition(def: AppDefinition): void {
  if (typeof def?.id !== "string" || !ID.test(def.id)) {
    throw new Error(`App id ${JSON.stringify(def?.id)} must be lower-case letters, digits and single hyphens`);
  }
  if (typeof def.name !== "string" || def.name.trim() === "") {
    throw new Error("App name must be a non-empty string");
  }
}
