// The framework's public entry: what an app may import.
/// <reference path="./runtime/globals.d.ts" />
export { loadFolder, pickFolder, regrant, forgetFolder, type FolderState } from "./runtime/host/folder";
export { openDb, type KeyValueDb } from "./runtime/host/idb";
export { loadPassport, regrantPassport, savePassport, pickPassport, readPassport, forgetPassport, readWorkspaceFile, type PassportState } from "./runtime/host/passport-file";
export type { Health, HealthState, Metrics, Trace } from "./runtime/host/engine-types";
export type { LoaderServices, UpdateResult } from "./runtime/loader/contract";
export type { AppDefinition, Migration, TableSchema } from "./runtime/definition";
export { OLDER_APP_MESSAGE } from "./runtime/definition";
export type { TableStatus } from "./data/registry";
export { appNames } from "./runtime/names";
export type { Register, Row, RowOf, Candidate } from "./data/schema";
export type { Query } from "./data/select";
export type { Conflict } from "./data/conflicts";
export { defineCommand, type CommandDef, type CommandResult, type Change, type Tx } from "./data/commands";
export { createData, type Data } from "./data/runtime";
export {
  DataProvider,
  useRecords,
  useRecord,
  useField,
  useCommand,
  useConflicts,
  useResolveConflict,
  resolveConflict,
  type FieldState,
  type BuiltinCommands,
} from "./react/hooks";
export { enrol, unlock, PassportError } from "./runtime/identity/passport.js";
export { KeyFileError } from "./runtime/identity/keyfile.js";
export type { Identity } from "./runtime/identity/types";
export {
  TrellisApp,
  type TrellisAppProps,
  mount,
  useHealth,
  defaultStrings,
  Button,
  buttonVariants,
  Badge,
  badgeVariants,
  type ShellStrings,
  type ShellStringOverrides,
  type HealthWording,
} from "./runtime/shell";
