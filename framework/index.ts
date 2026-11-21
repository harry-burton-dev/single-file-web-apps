// The framework's public entry: what an app may import.
/// <reference path="./runtime/globals.d.ts" />
export { startHost, type HostConfig, type HostStart } from "./runtime/host/host";
export { loadFolder, pickFolder, regrant, forgetFolder, type FolderState } from "./runtime/host/folder";
export { openDb, type KeyValueDb } from "./runtime/host/idb";
export { loadPassport, regrantPassport, savePassport, pickPassport, readPassport, forgetPassport, readWorkspaceFile, type PassportState } from "./runtime/host/passport-file";
export type { Engine, Health, HealthState, Metrics, SharedMap, Trace } from "./runtime/host/engine-types";
export type { LoaderServices, UpdateResult } from "./runtime/loader/contract";
export type { AppDefinition, TableSchema } from "./runtime/definition";
export { appNames } from "./runtime/names";
export type { Register } from "./data/schema";
export { enrol, unlock, PassportError } from "./runtime/identity/passport.js";
export { KeyFileError } from "./runtime/identity/keyfile.js";
export type { Identity } from "./runtime/identity/types";
