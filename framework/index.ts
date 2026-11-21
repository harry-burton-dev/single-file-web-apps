// @trellis/framework: what an app may import.
export { defineApp } from "./runtime/shell/define-app.tsx";
export type { Screen } from "./runtime/shell/app.tsx";
export { validateConfig } from "./config.ts";
export type { AppConfig, FieldDef, FieldType, TableDef } from "./config.ts";
// Temporary until the data layer (S2) replaces them.
export type { Engine } from "./runtime/host/engine-types.ts";
export { useSharedText } from "./runtime/shell/use-engine.ts";
