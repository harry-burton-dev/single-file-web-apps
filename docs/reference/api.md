# API reference

Everything an app may import comes from one place:

```ts
import { TrellisApp, mount, useRecords, useCommand, defineCommand } from "@trellis/framework";

export const everything = [TrellisApp, mount, useRecords, useCommand, defineCommand];
```

This page has one entry for each export. A test fails if an export is missing here, or if an entry names something that is not exported.

Most apps use the first four groups: the app shell, hooks, commands, and rows. The rest is what the shell is built from. It is exported, and described here, but the shell already calls it for you.

- [App shell](#app-shell)
- [Hooks](#hooks)
- [Commands](#commands)
- [Rows and queries](#rows-and-queries)
- [App definition](#app-definition)
- [Sync status](#sync-status)
- [Updates](#updates)
- [Folder and passport](#folder-and-passport)
- [Data runtime](#data-runtime)

## App shell

### `TrellisApp`

The component that wraps your screens. It shows everything between opening the page and your first screen: choosing the folder, opening an invite, unlocking the passport. Once sync has started it shows the sync status, the conflict prompt and your screens.

```ts signature
function TrellisApp(props: TrellisAppProps): JSX.Element
```

- `config`: the default export of `app/app.config.ts`.
- `strings`: optional. Rewords any of the shell's text. See [`ShellStringOverrides`](#shellstringoverrides).
- `children`: your screens. They render once sync has started, so every hook on this page works inside them.

**Caveats**

- An app can reword and restyle the shell. It cannot replace it or change its order.
- Render one `<TrellisApp>` per page.

```tsx
// app/src/main.tsx
import { mount, TrellisApp } from "@trellis/framework";
import config from "../app.config";
import css from "./index.css?inline";
import { ItemsScreen } from "./items-screen";

export const start = mount(
  <TrellisApp config={config} strings={{ chooseFolder: "Choose the team folder" }}>
    <ItemsScreen />
  </TrellisApp>,
  css,
);
```

### `TrellisAppProps`

The props of `TrellisApp`.

```ts signature
interface TrellisAppProps {
  config: AppDefinition;
  strings?: ShellStringOverrides;
  children?: ReactNode;
  services?: ShellServices; // for tests: stand-ins for the shell's side effects
}
```

### `mount`

Puts the app on the page. Call it once, in `app/src/main.tsx`, and export the result as `start`.

```ts signature
function mount(app: ReactNode, css: string): (services: LoaderServices) => void
```

- `app`: the element to render, normally `<TrellisApp>`.
- `css`: the app's stylesheet as text. Import it with `?inline`.

**Returns** the function the page calls to start the app. The build expects it as the export named `start`.

**Caveats**

- Under `npm run dev` the app renders at once into the element with id `app`. In a release, it renders when the page calls `start`.

### `defaultStrings`

Every piece of text the shell shows, in its default wording. Read it to see what you can change.

```ts signature
const defaultStrings: ShellStrings
```

### `ShellStrings`

The type of [`defaultStrings`](#defaultstrings): one property per piece of text. A property that carries data is a function, such as `needsDecision: (count: number) => string`. [Messages](messages.md) lists them with their default wording.

### `ShellStringOverrides`

What you pass as `strings` to `TrellisApp`: any subset of [`ShellStrings`](#shellstrings). Under `health`, you can change the label, the sentence, or both, for any state.

```tsx
import type { ShellStringOverrides } from "@trellis/framework";

export const strings: ShellStringOverrides = {
  chooseFolder: "Choose the team folder",
  health: { offline: { label: "No connection" } },
  waiting: (count) => `${count} not saved yet`,
};
```

### `HealthWording`

The wording for one sync state: a short `label` for the badge and a plain `sentence` that says what the state means for the person's work.

```ts signature
interface HealthWording {
  label: string;
  sentence: string;
}
```

### `Button`

The shell's button component, for screens that want to match it.

```ts signature
function Button(props: ButtonProps & { variant?: "default" | "outline" | "secondary" | "ghost" | "destructive" | "link"; size?: "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg" }): JSX.Element
```

It takes the props of an HTML button, plus `variant` and `size`.

```tsx
import { Button } from "@trellis/framework";

export function SaveRow() {
  return (
    <p>
      <Button type="submit">Save</Button>
      <Button type="button" variant="outline" size="sm">Cancel</Button>
    </p>
  );
}
```

### `buttonVariants`

Returns the class names [`Button`](#button) uses, so that a link or another element can look like one.

```tsx
import { buttonVariants } from "@trellis/framework";

export function HelpLink() {
  return <a className={buttonVariants({ variant: "outline", size: "sm" })} href="#help">Help</a>;
}
```

### `Badge`

The shell's badge component: a short label, as used for the sync status. `variant` is one of `default`, `secondary`, `destructive`, `outline`, `ghost` or `link`.

```tsx
import { Badge } from "@trellis/framework";

export function Overdue() {
  return <Badge variant="destructive">Overdue</Badge>;
}
```

### `badgeVariants`

Returns the class names [`Badge`](#badge) uses.

```tsx
import { badgeVariants } from "@trellis/framework";

export function Tag({ text }: { text: string }) {
  return <span className={badgeVariants({ variant: "secondary" })}>{text}</span>;
}
```

## Hooks

Call hooks only inside the children of `TrellisApp`. Table and field names are checked against `app/app.config.ts`.

### `useRecords`

Returns a table's rows, filtered and sorted, and re-renders when the result changes.

```ts signature
function useRecords<T extends TableName>(table: T, query?: Query<RowOf<T>>): readonly RowOf<T>[]
```

- `table`: a table name from `app/app.config.ts`.
- `query`: optional. See [`Query`](#query).

**Returns** the matching rows. Removed records are left out unless the query sets `includeDeleted`. The array keeps its identity from one render to the next while it holds the same rows.

**Caveats**

- Without `sort`, rows come in order of id.
- A `where` object compares with equality, so `{ done: false }` does not match a row whose `done` is not set.

```tsx
import { useRecords } from "@trellis/framework";

export function DoneCount() {
  const done = useRecords("items", { where: { done: true } });
  return <p>{done.length} done</p>;
}
```

### `useRecord`

Returns one record by id.

```ts signature
function useRecord<T extends TableName>(table: T, id: string): RowOf<T> | undefined
```

**Returns** the row, or `undefined` when no record has that id.

**Caveats**

- A removed record is returned. Check `_deleted`.

```tsx
import { useRecord } from "@trellis/framework";

export function ItemNotes({ id }: { id: string }) {
  const item = useRecord("items", id);
  return <p>{item && !item._deleted ? item.notes : "No such item."}</p>;
}
```

### `useField`

Returns one field of one record, with its conflict if it has one.

```ts signature
function useField<T extends TableName, F extends FieldName<T>>(table: T, id: string, field: F): FieldState<FieldValue<T, F>>
```

**Returns** a [`FieldState`](#fieldstate). The component re-renders only when that field changes.

```tsx
import { useField } from "@trellis/framework";

export function Title({ id }: { id: string }) {
  const title = useField("items", id, "title");
  return <h2>{title.value ?? "Untitled"}</h2>;
}
```

### `FieldState`

What [`useField`](#usefield) returns.

```ts signature
interface FieldState<V> {
  readonly value: V | undefined;
  readonly conflict: readonly Candidate<V>[] | null;
}
```

- `value`: the field's value. For an `ask` field in conflict, the provisional one: the most recently written.
- `conflict`: the candidates while an `ask` field is in conflict, otherwise `null`.

### `useCommand`

Returns a function that runs a command on this computer.

```ts signature
function useCommand<N extends keyof BuiltinCommands>(name: N): (input: BuiltinCommands[N][0]) => CommandResult<BuiltinCommands[N][1]>
function useCommand<I, V>(command: CommandDef<I, V>): (input: I) => CommandResult<V>
function useCommand(name: string): (input: unknown) => CommandResult
```

- `name`: the name of a built-in command, such as `"records.create"`.
- `command`: a command made with [`defineCommand`](#definecommand).

**Returns** a function that takes the command's input and returns a [`CommandResult`](#commandresult). The function keeps its identity across renders.

**Caveats**

- The function never throws. Check `ok` on the result.
- Passing the name of your own command as a string works, but its input and value are then untyped. Pass the command itself.

```tsx
import { useCommand } from "@trellis/framework";

export function DoneBox({ id, done }: { id: string; done: boolean }) {
  const update = useCommand("records.update");
  return <input type="checkbox" checked={done} onChange={(e) => update({ table: "items", id, fields: { done: e.target.checked } })} />;
}
```

### `BuiltinCommands`

The input and return value of each built-in command, by name. It is what types `useCommand("records.create")`.

| Name | Input | Value |
|---|---|---|
| `records.create` | `{ table, id?, fields? }` | the new record's id |
| `records.update` | `{ table, id, fields }` | nothing |
| `records.remove` | `{ table, id }` | nothing |
| `records.restore` | `{ table, id }` | nothing |
| `records.resolve` | `{ table, id, field, value }` | nothing |

**Caveats**

- `records.create` fails if the id is taken, even by a removed record.
- `records.update`, `remove`, `restore` and `resolve` fail if the record does not exist.

### `useConflicts`

Returns every open conflict on this computer.

```ts signature
function useConflicts(): readonly Conflict[]
```

**Returns** the conflicts, sorted by table, id and field. Conflicts on removed records are left out.

### `Conflict`

One `ask` field that holds more than one value.

```ts signature
interface Conflict {
  readonly table: string;
  readonly id: string;
  readonly field: string;
  readonly value: unknown; // the provisional value: the latest candidate
  readonly candidates: readonly Candidate<unknown>[];
}
```

### `useResolveConflict`

Returns a function that settles a conflict to one value.

```ts signature
function useResolveConflict(): (conflict: { table: string; id: string; field: string }, value: unknown) => CommandResult<void>
```

It runs the `records.resolve` command. The value can be one of the candidates or a different one.

```tsx
import { Button, useConflicts, useResolveConflict } from "@trellis/framework";

export function KeepLatest() {
  const conflicts = useConflicts();
  const resolve = useResolveConflict();
  return <Button onClick={() => conflicts.forEach((conflict) => resolve(conflict, conflict.value))}>Keep the latest value everywhere</Button>;
}
```

### `resolveConflict`

The function behind [`useResolveConflict`](#useresolveconflict), for code that holds a [`Data`](#data) object and is not a component.

```ts signature
function resolveConflict(data: Data, conflict: { table: string; id: string; field: string }, value: unknown): CommandResult<void>
```

### `useHealth`

Returns the sync status, kept current.

```ts signature
function useHealth(): Health | null
```

**Returns** a [`Health`](#health), or `null` before sync has started.

```tsx
import { useHealth } from "@trellis/framework";

export function SavedAt() {
  const health = useHealth();
  if (!health?.lastSaveAt) return null;
  return <p>Last saved at {new Date(health.lastSaveAt).toLocaleTimeString()}.</p>;
}
```

## Commands

### `defineCommand`

Defines a command: a named write that either happens in full or not at all.

```ts signature
function defineCommand<I = void, V = void>(name: string, handler: (tx: Tx, input: I) => V): CommandDef<I, V>
```

- `name`: unique in the app. It must not start with `records.`.
- `handler`: reads and writes through [`tx`](#tx). Whatever it returns becomes the result's `value`.

**Returns** a [`CommandDef`](#commanddef) to pass to [`useCommand`](#usecommand).

**Caveats**

- Call it at the top level of a module. A name used twice throws when the module loads.
- The handler is synchronous. Do not make it `async`.
- If the handler throws or calls `tx.fail`, nothing is written.

```ts
import { defineCommand } from "@trellis/framework";

export const rename = defineCommand("items.rename", (tx, input: { id: string; title: string }) => {
  if (input.title.trim() === "") tx.fail("A title cannot be empty.");
  tx.put("items", input.id, { title: input.title.trim() });
});
```

### `CommandDef`

A defined command: its `name` and its `handler`. You get one from [`defineCommand`](#definecommand) and pass it to [`useCommand`](#usecommand).

```ts signature
interface CommandDef<I = any, V = any> {
  readonly name: string;
  readonly handler: (tx: Tx, input: I) => V;
}
```

### `Tx`

What a command's handler reads and writes with.

```ts signature
interface Tx {
  readonly now: number;
  readonly user: string;
  readonly device: string;
  get<T extends TableName>(table: T, id: string): RowOf<T> | undefined;
  list<T extends TableName>(table: T, options?: { includeDeleted?: boolean }): readonly RowOf<T>[];
  newId(): string;
  id(...parts: string[]): string;
  put<T extends TableName>(table: T, id: string, fields: Fields<T>): void;
  remove(table: TableName, id: string): void;
  restore(table: TableName, id: string): void;
  resolve(table: TableName, id: string, field: string, value: unknown): void;
  fail(message: string): never;
}
```

- `now`: the time of this run, in milliseconds. It is read once, so every use in one run agrees.
- `user`, `device`: who is running the command, and on which device.
- `get`, `list`: read the data as it stood when the run began. They do not see this run's own changes. `list` leaves removed records out unless `includeDeleted` is `true`.
- `newId()`: a random id.
- `id(...parts)`: a predictable id built from its parts. Two computers that pass the same parts get the same id.
- `put`: sets fields on a record. It creates the record if there is none.
- `remove`, `restore`: mark a record deleted, or bring it back.
- `resolve`: settles an `ask` field to one value.
- `fail`: ends the run with `{ ok: false, code: "failed", error: message }`.

**Caveats**

- Changes are checked after the handler returns. A field the table does not declare, a value of the wrong type, or a `put` to a removed record fails the whole run with the code `invalid`.

### `CommandResult`

What running a command returns.

```ts signature
type CommandResult<V = unknown> =
  | { ok: true; value: V; changes: readonly Change[] }
  | { ok: false; error: string; code: "failed" | "invalid" | "schema-too-new" | "unknown-command" }
```

When `ok` is `false`, nothing was written. [Write a command](../guides/write-a-command.md#handle-a-failure) says what each code means.

### `Change`

One write a command made, as listed in a successful [`CommandResult`](#commandresult).

```ts signature
type Change =
  | { op: "put"; table: string; id: string; fields: Record<string, unknown> }
  | { op: "remove" | "restore"; table: string; id: string }
  | { op: "resolve"; table: string; id: string; field: string; value: unknown }
```

## Rows and queries

### `RowOf`

The type of a row of one of your tables, by table name.

```tsx
import type { RowOf } from "@trellis/framework";

export function ItemLine({ item }: { item: RowOf<"items"> }) {
  return <li>{item.title}</li>;
}
```

It depends on [`Register`](#register). Without the registration, every table name is accepted and fields are untyped.

### `Row`

The type of a row, from a table's schema. [`RowOf`](#rowof) is the form you normally use.

```ts signature
type Row<S extends TableSchema> = {
  readonly id: string;
  readonly _deleted: boolean;
  readonly _conflicts: { readonly [field]?: readonly Candidate<Value>[] }; // ask fields only
} & { readonly [field]?: Value }
```

Every declared field is optional.

### `Candidate`

One device's value for an `ask` field in conflict.

```ts signature
interface Candidate<V> {
  readonly value: V;
  readonly user: string;
  readonly device: string;
  readonly writtenAt: number;
}
```

`writtenAt` is the writing computer's clock, in milliseconds. Show it, but do not rely on it to order events.

### `Query`

The second argument of [`useRecords`](#userecords).

```ts signature
interface Query<R> {
  where?: Partial<R> | ((row: R) => boolean);
  sort?: keyof R | { by: keyof R; dir?: "asc" | "desc" } | ((a: R, b: R) => number);
  includeDeleted?: boolean;
}
```

- `where`: an object matches rows whose fields equal every value given. A function is a filter.
- `sort`: a field name, a field with a direction, or a compare function. Rows with no value for the field sort last in both directions. Values are compared with `<` and `>`, so strings sort by character code: upper case before lower case.
- `includeDeleted`: `true` to include removed records.

### `Register`

The interface your app extends, once, to tell the framework its definition. It is what makes table names, field names and rows typed.

```ts
// app/app.config.ts
import type { AppDefinition } from "@trellis/framework";

const config = {
  id: "my-app",
  name: "My App",
  tables: {
    items: {
      version: 1,
      fields: {
        title: { kind: "latest", type: "string" },
        done: { kind: "latest", type: "boolean" },
        notes: "text",
        owner: { kind: "ask", type: "string" },
      },
    },
  },
} satisfies AppDefinition;

export default config;

declare module "@trellis/framework" {
  interface Register {
    config: typeof config;
  }
}
```

## App definition

[`app.config.ts` reference](app-config.md) describes the file itself.

### `AppDefinition`

The type of the default export of `app/app.config.ts`.

```ts signature
type AppDefinition = {
  id: string;
  name: string;
  tables: Record<string, TableSchema>;
  migrations?: Record<string, Record<number, Migration>>;
}
```

### `TableSchema`

One table: its version and its fields.

```ts signature
type TableSchema = {
  version: number;
  fields?: Record<string, FieldDef>;
}
```

A field is `"latest"`, `"ask"`, `"text"`, `{ kind: "text" }`, or `{ kind: "latest" | "ask", type: "string" | "number" | "boolean" }`.

### `Migration`

One migration step: it takes a record's fields at one version and returns them at the next.

```ts signature
type Migration = (record: Record<string, unknown>) => Record<string, unknown>
```

### `OLDER_APP_MESSAGE`

The text a command fails with when its table was written by a newer version of the app.

```ts
import { OLDER_APP_MESSAGE, type CommandResult } from "@trellis/framework";

export function needsUpdate(result: CommandResult): boolean {
  return !result.ok && result.code === "schema-too-new" && result.error.includes(OLDER_APP_MESSAGE);
}
```

### `TableStatus`

Whether this version of the app may write a table.

```ts signature
type TableStatus =
  | { writable: true; storedVersion: number | undefined; supportedVersion: number }
  | { writable: false; storedVersion: number; supportedVersion: number; message: typeof OLDER_APP_MESSAGE }
```

**Caveats**

- The type is exported, but no exported function returns it. A screen learns that a table is not writable from a command's result, with the code `schema-too-new`.

### `appNames`

Returns every name the framework derives from the app's id and name.

```ts signature
function appNames(app: { id: string; name: string }): {
  database: string;
  adminDatabase: string;
  deviceLock: (deviceId: string) => string;
  folderPicker: string;
  title: string;
  bootstrapFile: string;
  adminFile: string;
  bundleFile: (version: string) => string;
  releaseFolder: string;
  releaseZip: (version: string) => string;
}
```

```ts
import { appNames } from "@trellis/framework";

const names = appNames({ id: "my-app", name: "My App" });

export const page = names.bootstrapFile; // "my-app.html"
export const zip = names.releaseZip("0.2.0"); // "my-app-0.2.0.zip"
```

## Sync status

### `Health`

The sync status, as [`useHealth`](#usehealth) returns it.

```ts signature
interface Health {
  state: HealthState;
  since: number;
  lastSaveAt: number | null;
  lastScanAt: number | null;
  lastScanOkAt: number | null;
  pending: number;
  nextSaveAt: number | null;
  retryAt: number | null;
  peers: Record<string, { user: string; lastHeardAt: number | null; lastAckedAt: number | null; active: boolean; ackedLatest: boolean; waitingSince: number | null }>;
}
```

- `state`: see [`HealthState`](#healthstate). `since` is when it began.
- `lastSaveAt`: when this computer last saved to the folder.
- `lastScanAt`, `lastScanOkAt`: when it last read the folder, and last read it without an error.
- `pending`: the number of changes not yet saved to the folder.
- `peers`: one entry for each colleague's device, by device id.

Times are in milliseconds, on this computer's clock.

### `HealthState`

The six sync states.

| State | Meaning |
|---|---|
| `saved` | Every change is in the shared folder. |
| `saving` | The latest changes are being saved. |
| `retrying` | A save failed and will be tried again. |
| `folder-disconnected` | The folder cannot be reached. |
| `not-reaching-peers` | Changes are saved, but colleagues' devices have not picked them up. |
| `offline` | The computer is offline. |

In every state, changes are safe on this computer.

### `Metrics`

The counters the shell's diagnostics view shows: save and folder-read timings, the backlog, conflict counts and the error count.

**Caveats**

- The type is exported, but no exported function returns it. The numbers are shown in the diagnostics view, which opens from the sync status badge.

### `Trace`

One sync attempt as the diagnostics view lists it: its kind (`save`, `scan`, `status`, `compaction` or `reseed`), outcome, duration and file steps.

**Caveats**

- The type is exported, but no exported function returns it.

## Updates

### `LoaderServices`

What the page hands to the function [`mount`](#mount) returns: the running version, the element to render into, and the update check.

```ts signature
interface LoaderServices {
  contract: 1;
  bootstrapVersion: number;
  version: string;
  safe: boolean;
  mount: HTMLElement;
  checkForUpdate(root: FileSystemDirectoryHandle): Promise<UpdateResult>;
  onUpdate?(listener: (result: UpdateResult) => void): () => void;
}
```

The shell uses these for you. It checks for an update once the folder is connected, and shows the result.

### `UpdateResult`

The result of one update check.

```ts signature
type UpdateResult =
  | { status: "current"; version: string }
  | { status: "updated"; version: string }
  | { status: "rejected"; code: string; message: string }
```

- `current`: nothing new.
- `updated`: a new version is verified and stored. It runs the next time the page loads.
- `rejected`: the release in the folder was refused. The version already stored keeps running. [Messages](messages.md#updates) lists each code.

## Folder and passport

The shell calls these during its first-run steps. An app has no need to call them. They are documented because they are exported.

### `openDb`

Opens a key-value store in the browser, by name.

```ts signature
function openDb(name: string): Promise<KeyValueDb>
```

### `KeyValueDb`

The store [`openDb`](#opendb) returns.

```ts signature
interface KeyValueDb {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
}
```

### `loadFolder`

Returns the shared folder remembered from an earlier visit, without prompting.

```ts signature
function loadFolder(db: KeyValueDb): Promise<FolderState>
```

### `pickFolder`

Shows the browser's folder picker and remembers the choice. Call it from a click.

```ts signature
function pickFolder(db: KeyValueDb, pickerId: string): Promise<FolderState>
```

**Returns** `{ status: "none" }` if the person cancels.

### `regrant`

Asks the browser to restore access to a remembered folder. Call it from a click.

```ts signature
function regrant(handle: FileSystemDirectoryHandle): Promise<FolderState>
```

### `forgetFolder`

Forgets the remembered folder.

```ts signature
function forgetFolder(db: KeyValueDb): Promise<void>
```

### `FolderState`

Where the app stands with the shared folder.

```ts signature
type FolderState =
  | { status: "none" }
  | { status: "needs-permission"; handle: FileSystemDirectoryHandle }
  | { status: "ready"; handle: FileSystemDirectoryHandle }
```

```ts
import { loadFolder, openDb, regrant, type FolderState } from "@trellis/framework";

export async function reconnect(): Promise<FolderState> {
  const db = await openDb("my-app");
  const folder = await loadFolder(db);
  return folder.status === "needs-permission" ? regrant(folder.handle) : folder;
}
```

### `loadPassport`

Returns the passport file remembered from an earlier visit, without prompting.

```ts signature
function loadPassport(db: KeyValueDb): Promise<PassportState>
```

### `pickPassport`

Shows the file picker for a passport saved earlier, and remembers it. Call it from a click.

```ts signature
function pickPassport(db: KeyValueDb): Promise<PassportState>
```

### `savePassport`

Shows the save picker, writes the passport and remembers it. Call it from a click.

```ts signature
function savePassport(db: KeyValueDb, passport: { passportText: string; fileName: string }): Promise<PassportState>
```

### `regrantPassport`

Asks the browser to restore read access to a remembered passport. Call it from a click.

```ts signature
function regrantPassport(handle: FileSystemFileHandle): Promise<Exclude<PassportState, { status: "none" }>>
```

### `readPassport`

Reads a passport file's text.

```ts signature
function readPassport(handle: FileSystemFileHandle): Promise<string>
```

### `forgetPassport`

Forgets the remembered passport. The file itself is not touched.

```ts signature
function forgetPassport(db: KeyValueDb): Promise<void>
```

### `PassportState`

Where the app stands with the passport file. It has the same three states as [`FolderState`](#folderstate), with a file handle.

```ts signature
type PassportState =
  | { status: "none" }
  | { status: "needs-permission"; handle: FileSystemFileHandle }
  | { status: "ready"; handle: FileSystemFileHandle }
```

### `readWorkspaceFile`

Reads `workspace.json` from the root of the shared folder.

```ts signature
function readWorkspaceFile(root: FileSystemDirectoryHandle): Promise<string | null>
```

**Returns** the file's text, or `null` when the folder has no workspace.

### `enrol`

Opens an invite with its one-time passphrase and seals its keys again under the person's own passphrase.

```ts signature
function enrol(args: { inviteText: string; invitePassphrase: string; newPassphrase: string; random: { bytes(n: number): Uint8Array } }): Promise<{ passportText: string; fileName: string; user: { id: string; name: string } }>
```

**Returns** the passport's text and the file name to save it under.

**Caveats**

- It throws a [`KeyFileError`](#keyfileerror) for a wrong passphrase, a file that is not an invite, or a new passphrase under 12 characters.

### `unlock`

Opens a passport, checks it against the folder's workspace, and returns the person's identity and keys.

```ts signature
function unlock(args: { passportText: string; passphrase: string; workspaceText: string | null }): Promise<Identity>
```

**Caveats**

- It throws a [`KeyFileError`](#keyfileerror) for a wrong passphrase or a file that is not a passport.
- It throws a [`PassportError`](#passporterror) when the passport does not fit the folder.

### `Identity`

What [`unlock`](#unlock) returns: who the person is, and the keys to read and write with.

```ts signature
interface Identity {
  user: { id: string; name: string };
  keyId: number;
  key: CryptoKey;
  keys: Map<number, CryptoKey>;
}
```

The keys are held in memory only and cannot be exported from the browser.

### `PassportError`

Thrown by [`unlock`](#unlock) when a passport does not fit the folder. Its `message` is written for the person and can be shown as it is.

| `code` | `message` |
|---|---|
| `other-workspace` | This passport is for a different workspace. |
| `out-of-date` | Your passport is out of date. Ask the admin for a new invite. |
| `no-workspace` | This folder has no workspace yet. Ask the admin to create one. |
| `bad-workspace` | The workspace file in this folder is damaged. Ask the admin to check it. |

### `KeyFileError`

Thrown when an invite, passport or key backup cannot be opened or made. Its `message` is written for the person.

| `code` | `message` |
|---|---|
| `wrong-passphrase` | That passphrase does not open this file. |
| `bad-file` | This is not a valid invite file. (or passport file, or key backup file) |
| `wrong-kind` | This is a passport file, not an invite file. (and the other pairs) |
| `weak-passphrase` | Use a passphrase of at least 12 characters. |

```ts
import { KeyFileError, PassportError, unlock, type Identity } from "@trellis/framework";

export async function tryUnlock(passportText: string, passphrase: string, workspaceText: string | null): Promise<Identity | string> {
  try {
    return await unlock({ passportText, passphrase, workspaceText });
  } catch (error: unknown) {
    if (error instanceof KeyFileError || error instanceof PassportError) return error.message;
    throw error;
  }
}
```

## Data runtime

### `DataProvider`

Gives the components below it one device's data. `TrellisApp` renders it around your screens.

```ts signature
function DataProvider(props: { data: Data; children?: ReactNode }): ReactElement
```

**Caveats**

- A hook called outside it throws "Data hooks must be inside &lt;DataProvider&gt;".

### `Data`

One device's data: its tables, its open conflicts, and the function that runs commands.

```ts signature
interface Data {
  readonly tables: readonly string[];
  view(table: string): TableView;
  readonly conflicts: Store<readonly Conflict[]>;
  run<I, V>(command: string | CommandDef<I, V>, input: I): CommandResult<V>;
  commandLog(): readonly CommandRun[];
  close(): void;
}
```

- `run`: runs a command. [`useCommand`](#usecommand) calls it.
- `commandLog()`: the most recent runs on this device, up to 200, kept in memory.

### `createData`

Makes the [`Data`](#data) for a running sync engine. The shell calls it once sync has started.

**Caveats**

- It needs the sync engine, and no export gives an app one. App code has no way to call it. It is exported for the shell.
