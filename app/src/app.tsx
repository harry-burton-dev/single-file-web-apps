// Engine test page: connect a folder, unlock a passport, edit one shared note,
// and watch the health indicator; its menu opens the diagnostics view. Real screens replace this.
//
// Keys come only from the user's passport (TR3, ADR-0003 section 2): once, the
// admin's invite is turned into a passport saved on this machine; at every
// launch the passport is unlocked with the user's passphrase. Keys are held in
// memory for the session. IndexedDB keeps the folder and passport handles and
// the device id, never a key.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  appNames,
  Button,
  enrol,
  forgetPassport,
  HealthIndicator,
  KeyFileError,
  loadFolder,
  loadPassport,
  openDb,
  PassportError,
  pickFolder,
  pickPassport,
  readPassport,
  readWorkspaceFile,
  regrant,
  regrantPassport,
  savePassport,
  ShellProvider,
  startHost,
  unlock,
  type Engine,
  type FolderState,
  type Identity,
  type KeyValueDb,
  type PassportState,
} from "@trellis/framework";
import app from "../app.config";
import { loader } from "./loader-services";
import { useSharedText } from "./use-engine";

const names = appNames(app);
const TABLE = "scratch";
const DEV_PRIVATE_FOLDER_HASH = "#private-folder";
const random = { bytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)) };

/** Development only: the browser's private file area, so the page can be exercised without a folder picker. */
async function privateFolder(): Promise<FolderState> {
  const origin = await navigator.storage.getDirectory();
  return { status: "ready", handle: await origin.getDirectoryHandle(`${app.id}-test`, { create: true }) };
}

type Running = { phase: "running"; db: KeyValueDb; root: FileSystemDirectoryHandle; engine: Engine; stop: () => Promise<void>; deviceId: string; user: Identity["user"] };
type Session =
  | { phase: "loading" }
  | { phase: "folder"; db: KeyValueDb; folder: FolderState; message?: string }
  | { phase: "passport"; db: KeyValueDb; root: FileSystemDirectoryHandle; message?: string }
  | { phase: "unlock"; db: KeyValueDb; root: FileSystemDirectoryHandle; passport: Exclude<PassportState, { status: "none" }>; message?: string }
  | Running;

/** KeyFileError and PassportError messages are written for the user and shown as they are. */
function describeError(error: unknown): string {
  if (error instanceof KeyFileError || error instanceof PassportError) return error.message;
  return error instanceof Error ? `${error.name}: ${error.message}` : "Unexpected error";
}

async function afterFolder(db: KeyValueDb, folder: FolderState): Promise<Session> {
  if (folder.status !== "ready") return { phase: "folder", db, folder };
  const passport = await loadPassport(db);
  if (passport.status === "none") return { phase: "passport", db, root: folder.handle };
  return { phase: "unlock", db, root: folder.handle, passport };
}

/** Starts the engine with the unlocked keys. The device id is kept while the user id stays the same. */
async function start(db: KeyValueDb, root: FileSystemDirectoryHandle, identity: Identity): Promise<Running | string> {
  const started = await startHost({ root, db, user: identity.user.id, key: identity.key, keyId: identity.keyId, keys: identity.keys, app });
  if (!started.ok) return `${app.name} is already open in another tab.`;
  void loader()?.checkForUpdate(root);
  return { phase: "running", db, root, engine: started.engine, stop: started.stop, deviceId: started.deviceId, user: identity.user };
}

function Message({ text }: { text?: string }) {
  return text ? (
    <p id="message" className="text-sm text-destructive">
      {text}
    </p>
  ) : null;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      {children}
    </label>
  );
}

const inputClass = "rounded-md border px-2 py-1";

function FolderStep({ session, onChange }: { session: Extract<Session, { phase: "folder" }>; onChange: (next: Session) => void }) {
  const { db, folder } = session;
  const run = (action: () => Promise<FolderState>) => async (): Promise<void> => {
    try {
      onChange(await afterFolder(db, await action()));
    } catch (error: unknown) {
      onChange({ ...session, message: describeError(error) });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {folder.status === "needs-permission" ? (
        <Button onClick={run(() => regrant(folder.handle))}>Reconnect to "{folder.handle.name}"</Button>
      ) : (
        <Button onClick={run(() => pickFolder(db, names.folderPicker))}>Choose the shared folder</Button>
      )}
      <Message text={session.message} />
    </div>
  );
}

/**
 * Opens the admin's invite under its one-time passphrase and makes a passport
 * under the user's own. Two clicks: opening takes a few seconds of key
 * stretching, and the browser only shows the save picker straight after a click.
 */
function InviteForm({ db, root, onDone, onCancel }: { db: KeyValueDb; root: FileSystemDirectoryHandle; onDone: (identity: Identity) => Promise<void>; onCancel?: () => void }) {
  const [file, setFile] = useState<File | undefined>();
  const [invitePassphrase, setInvitePassphrase] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [made, setMade] = useState<{ passportText: string; fileName: string; identity: Identity } | undefined>();

  const open = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!file) return setMessage("Choose the invite file first.");
    if (newPassphrase !== confirm) return setMessage("The two new passphrases do not match.");
    setBusy(true);
    setMessage(undefined);
    try {
      const { passportText, fileName } = await enrol({ inviteText: await file.text(), invitePassphrase, newPassphrase, random });
      // Checked against this folder before anything is saved, so a wrong folder is found now.
      const identity: Identity = await unlock({ passportText, passphrase: newPassphrase, workspaceText: await readWorkspaceFile(root) });
      setMade({ passportText, fileName, identity });
    } catch (error: unknown) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!made) return;
    setBusy(true);
    try {
      const saved = await savePassport(db, made);
      if (saved.status === "none") setMessage("The passport was not saved. Save it to continue.");
      else await onDone(made.identity);
    } catch (error: unknown) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  if (made) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          Invite accepted for {made.identity.user.name}. Save your passport somewhere on this computer, not in the shared folder. You will choose it once and then type your passphrase at each launch. The invite file can then be deleted.
        </p>
        <Button id="save-passport" disabled={busy} onClick={() => void save()}>
          Save my passport
        </Button>
        <Message text={message} />
      </div>
    );
  }
  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void open(event)}>
      <Field label="Invite file from the admin">
        <input id="invite-file" type="file" accept=".json,application/json" className="text-sm" onChange={(event) => setFile(event.target.files?.[0])} />
      </Field>
      <Field label="The invite's passphrase (from the admin)">
        <input id="invite-passphrase" type="password" className={inputClass} value={invitePassphrase} onChange={(event) => setInvitePassphrase(event.target.value)} />
      </Field>
      <Field label="Choose your own passphrase (at least 12 characters)">
        <input id="new-passphrase" type="password" autoComplete="new-password" className={inputClass} value={newPassphrase} onChange={(event) => setNewPassphrase(event.target.value)} />
      </Field>
      <Field label="Type it again">
        <input id="confirm-passphrase" type="password" autoComplete="new-password" className={inputClass} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button id="open-invite" type="submit" disabled={busy}>
          {busy ? "Opening the invite" : "Open the invite"}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <Message text={message} />
    </form>
  );
}

function PassportStep({ session, onChange }: { session: Extract<Session, { phase: "passport" }>; onChange: (next: Session) => void }) {
  const { db, root } = session;
  const [inviting, setInviting] = useState(false);
  const fail = (error: unknown): void => onChange({ ...session, message: describeError(error) });

  if (inviting) {
    const done = async (identity: Identity): Promise<void> => {
      const next = await start(db, root, identity);
      onChange(typeof next === "string" ? { ...session, message: next } : next);
    };
    return <InviteForm db={db} root={root} onDone={done} onCancel={() => setInviting(false)} />;
  }
  const choose = async (): Promise<void> => {
    try {
      const passport = await pickPassport(db);
      if (passport.status !== "none") onChange({ phase: "unlock", db, root, passport });
    } catch (error: unknown) {
      fail(error);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">To open {app.name} on this computer you need an invite from the admin, or the passport you saved from one.</p>
      <div className="flex gap-2">
        <Button id="have-invite" onClick={() => setInviting(true)}>
          I have an invite
        </Button>
        <Button id="have-passport" variant="outline" onClick={() => void choose()}>
          I have a passport
        </Button>
      </div>
      <Message text={session.message} />
    </div>
  );
}

function UnlockStep({ session, onChange }: { session: Extract<Session, { phase: "unlock" }>; onChange: (next: Session) => void }) {
  const { db, root } = session;
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      // Asked first, while the click still counts as the user's.
      const passport = session.passport.status === "ready" ? session.passport : await regrantPassport(session.passport.handle);
      if (passport.status !== "ready") return onChange({ ...session, passport, message: "Allow access to your passport file to continue." });
      const identity: Identity = await unlock({ passportText: await readPassport(passport.handle), passphrase, workspaceText: await readWorkspaceFile(root) });
      const next = await start(db, root, identity);
      onChange(typeof next === "string" ? { ...session, passport, message: next } : next);
    } catch (error: unknown) {
      onChange({ ...session, message: describeError(error) });
    } finally {
      setBusy(false);
    }
  };
  const other = async (): Promise<void> => {
    await forgetPassport(db);
    onChange({ phase: "passport", db, root });
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
      <Field label={`Passphrase for your passport "${session.passport.handle.name}"`}>
        <input id="passphrase" type="password" autoComplete="current-password" autoFocus className={inputClass} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button id="unlock" type="submit" disabled={busy}>
          {busy ? "Unlocking" : "Unlock"}
        </Button>
        <Button id="switch-passport" type="button" variant="outline" onClick={() => void other()}>
          Use another passport or an invite
        </Button>
      </div>
      <Message text={session.message} />
    </form>
  );
}

function RunningView({ session, onChange }: { session: Running; onChange: (next: Session) => void }) {
  const map = session.engine.table(TABLE).getMap("note");
  const text = useSharedText(map, "text");
  const [inviting, setInviting] = useState(false);

  /** After a key rotation: enrol from the new invite, then restart the engine with the new keys. */
  const replaced = async (identity: Identity): Promise<void> => {
    await session.stop();
    const next = await start(session.db, session.root, identity);
    onChange(typeof next === "string" ? ({ ...(await afterFolder(session.db, { status: "ready", handle: session.root })), message: next } as Session) : next);
  };

  return (
    <ShellProvider engine={session.engine} onUpdate={loader()?.onUpdate}>
      <div className="flex flex-col gap-4">
        <HealthIndicator />
        <p className="text-xs text-muted-foreground">
          {session.user.name}, device {session.deviceId}, folder "{session.root.name}"
        </p>
        <textarea
          id="note"
          className="min-h-32 rounded-md border p-2 text-sm"
          placeholder="Shared test note"
          value={text}
          onChange={(event) => map.set("text", event.target.value)}
        />
        {inviting ? (
          <InviteForm db={session.db} root={session.root} onDone={replaced} onCancel={() => setInviting(false)} />
        ) : (
          <Button id="new-invite" variant="outline" className="self-start" onClick={() => setInviting(true)}>
            Open a new invite
          </Button>
        )}
      </div>
    </ShellProvider>
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
    const db = await openDb(names.database);
    if (import.meta.env.DEV && location.hash === DEV_PRIVATE_FOLDER_HASH) return afterFolder(db, await privateFolder());
    return afterFolder(db, await loadFolder(db));
  })();
  return booting;
}

export function App() {
  const [session, setSession] = useState<Session>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    boot()
      .then((next) => !cancelled && setSession(next))
      .catch((error: unknown) => !cancelled && setSession({ phase: "folder", db: nullDb, folder: { status: "none" }, message: describeError(error) }));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <h1 className="text-lg font-semibold">{app.name} engine test page</h1>
      <p className="text-xs text-muted-foreground">
        Version {__APP_VERSION__}, built {__BUILT_AT__}.
      </p>
      {session.phase === "loading" && <p id="loading" className="text-sm">Starting</p>}
      {session.phase === "folder" && <FolderStep session={session} onChange={setSession} />}
      {session.phase === "passport" && <PassportStep session={session} onChange={setSession} />}
      {session.phase === "unlock" && <UnlockStep key={session.passport.handle.name} session={session} onChange={setSession} />}
      {session.phase === "running" && <RunningView session={session} onChange={setSession} />}
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
