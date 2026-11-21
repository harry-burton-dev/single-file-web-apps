// Engine test page: connect a folder, edit one shared note, and watch the
// connection indicator and sync inspector. Real screens replace this.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Engine } from "@/host/engine-types";
import { loadFolder, pickFolder, regrant, type FolderState } from "@/host/folder";
import { startHost } from "@/host/host";
import { openDb, type KeyValueDb } from "@/host/idb";
import { ConnectionIndicator } from "./connection-indicator";
import { loader } from "./loader-services";
import { testWorkspaceKey } from "./test-key";
import { SyncInspector } from "./sync-inspector";
import { useSharedText, useSync } from "./use-engine";

const DB_NAME = "workbench";
const USER_KEY = "host/user";
const USER_RE = /^[a-z][a-z0-9]{1,15}$/;
const TABLE = "scratch";
const DEV_PRIVATE_FOLDER_HASH = "#private-folder";

/** Development only: the browser's private file area, so the page can be exercised without a folder picker. */
async function privateFolder(): Promise<FolderState> {
  const origin = await navigator.storage.getDirectory();
  return { status: "ready", handle: await origin.getDirectoryHandle("workbench-test", { create: true }) };
}

type Session =
  | { phase: "loading" }
  | { phase: "setup"; db: KeyValueDb; folder: FolderState; user: string; message?: string }
  | { phase: "running"; engine: Engine; deviceId: string; folderName: string };

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "Unexpected error";
}

async function begin(db: KeyValueDb, folder: FolderState, user: string): Promise<Session> {
  if (folder.status !== "ready") return { phase: "setup", db, folder, user };
  if (!USER_RE.test(user)) return { phase: "setup", db, folder, user, message: "Enter a short lower-case name first." };
  await db.set(USER_KEY, user);
  const started = await startHost({ root: folder.handle, db, user, key: await testWorkspaceKey(), keyId: 0, tables: { [TABLE]: "yjs" } });
  if (!started.ok) return { phase: "setup", db, folder, user, message: "Workbench is already open in another tab." };
  void loader()?.checkForUpdate(folder.handle);
  return { phase: "running", engine: started.engine, deviceId: started.deviceId, folderName: folder.handle.name };
}

function Setup({ session, onChange }: { session: Extract<Session, { phase: "setup" }>; onChange: (next: Session) => void }) {
  const { db, folder, user } = session;
  const run = (action: () => Promise<FolderState>) => async (): Promise<void> => {
    try {
      onChange(await begin(db, await action(), user));
    } catch (error: unknown) {
      onChange({ ...session, message: describeError(error) });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Your name (lower-case letters and digits)
        <input
          id="user"
          className="rounded-md border px-2 py-1"
          value={user}
          onChange={(event) => onChange({ ...session, user: event.target.value.trim().toLowerCase(), message: undefined })}
        />
      </label>
      {folder.status === "needs-permission" ? (
        <Button onClick={run(() => regrant(folder.handle))}>Reconnect to "{folder.handle.name}"</Button>
      ) : (
        <Button onClick={run(() => pickFolder(db))}>Choose the shared folder</Button>
      )}
      {session.message && <p id="message" className="text-sm text-destructive">{session.message}</p>}
    </div>
  );
}

function Running({ session }: { session: Extract<Session, { phase: "running" }> }) {
  const view = useSync(session.engine);
  const map = session.engine.table(TABLE).getMap("note");
  const text = useSharedText(map, "text");
  return (
    <div className="flex flex-col gap-4">
      <ConnectionIndicator health={view.health} />
      <p className="text-xs text-muted-foreground">
        Device {session.deviceId}, folder "{session.folderName}"
      </p>
      <textarea
        id="note"
        className="min-h-32 rounded-md border p-2 text-sm"
        placeholder="Shared test note"
        value={text}
        onChange={(event) => map.set("text", event.target.value)}
      />
      <SyncInspector engine={session.engine} view={view} />
    </div>
  );
}

let booting: Promise<Session> | undefined;

/**
 * Start-up runs once per page, however many times React mounts the component
 * (development mode mounts twice). Running it twice would create two device
 * ids and two engines writing to the same folder.
 */
function boot(): Promise<Session> {
  booting ??= (async () => {
    const db = await openDb(DB_NAME);
    const saved = await db.get(USER_KEY);
    if (import.meta.env.DEV && location.hash === DEV_PRIVATE_FOLDER_HASH) return begin(db, await privateFolder(), "tester");
    return begin(db, await loadFolder(db), typeof saved === "string" ? saved : "");
  })();
  return booting;
}

export function App() {
  const [session, setSession] = useState<Session>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    boot()
      .then((next) => !cancelled && setSession(next))
      .catch((error: unknown) => !cancelled && setSession({ phase: "setup", db: nullDb, folder: { status: "none" }, user: "", message: describeError(error) }));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <h1 className="text-lg font-semibold">Workbench engine test page</h1>
      <p className="text-xs text-muted-foreground">
        Version {__APP_VERSION__}, built {__BUILT_AT__}. Uses a fixed test key: do not put real information in this page.
      </p>
      {session.phase === "loading" && <p id="loading" className="text-sm">Starting</p>}
      {session.phase === "setup" && <Setup session={session} onChange={setSession} />}
      {session.phase === "running" && <Running session={session} />}
    </div>
  );
}

/** Stands in when IndexedDB itself cannot be opened, so the error can still be shown. */
const nullDb: KeyValueDb = {
  get: async () => undefined,
  set: async () => undefined,
  delete: async () => undefined,
  keys: async () => [],
};
