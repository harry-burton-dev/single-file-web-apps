// The screens of the first-run flow, before the app's own (spec S4, Deliver 1).
// The invite and passport steps are TR3's, moved here as built. Each screen
// runs its side effects through the shell's services and reports the outcome
// to the reducer in machine.ts.
import { useState, type FormEvent, type ReactNode } from "react";
import { KeyFileError } from "../identity/keyfile.js";
import { PassportError } from "../identity/passport.js";
import type { AppDefinition } from "../definition";
import type { FolderState } from "../host/folder";
import type { KeyValueDb } from "../host/idb";
import type { Identity } from "../identity/types";
import type { ShellStrings } from "./strings";
import type { ShellEvent, ShellState } from "./machine";
import type { ShellServices } from "./services";
import { useShell } from "./context";
import { Button } from "./ui/button";

export interface Flow {
  config: AppDefinition;
  services: ShellServices;
  dispatch: (event: ShellEvent) => void;
  /** Starts the engine with the unlocked keys and reports the result. */
  start: (db: KeyValueDb, root: FileSystemDirectoryHandle, identity: Identity) => Promise<void>;
}

type Phase<P extends ShellState["phase"]> = Extract<ShellState, { phase: P }>;

/** KeyFileError and PassportError messages are written for the user and shown as they are. */
export function describeError(error: unknown, strings: ShellStrings): string {
  if (error instanceof KeyFileError || error instanceof PassportError) return error.message;
  // DOMException is an Error in browsers but not in every test environment.
  if (error instanceof Error || error instanceof DOMException) return `${error.name}: ${error.message}`;
  return strings.unexpectedError;
}

/** Reports a folder outcome, with the remembered passport once the folder is ready. */
export async function folderEvent(services: ShellServices, db: KeyValueDb, folder: FolderState, message?: string): Promise<ShellEvent> {
  const passport = folder.status === "ready" ? await services.loadPassport(db) : ({ status: "none" } as const);
  return { type: "folder", db, folder, passport, message };
}

export function Message({ text }: { text?: string }) {
  return text ? (
    <p id="message" role="alert" className="text-sm text-destructive">
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

const inputClass = "rounded-md border bg-background px-2 py-1";

export function FolderStep({ state, flow }: { state: Phase<"folder">; flow: Flow }) {
  const { strings } = useShell();
  const { db, folder } = state;
  const run = (action: () => Promise<FolderState>) => async (): Promise<void> => {
    try {
      const next = await action();
      flow.dispatch(await folderEvent(flow.services, db, next, next.status === "needs-permission" ? strings.folderRefused : undefined));
    } catch (error: unknown) {
      flow.dispatch({ type: "message", message: describeError(error, strings) });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {folder.status === "needs-permission" ? (
        <Button onClick={run(() => flow.services.regrant(folder.handle))}>{strings.reconnectTo(folder.handle.name)}</Button>
      ) : (
        <Button onClick={run(() => flow.services.pickFolder(db, `${flow.config.id}-folder`))}>{strings.chooseFolder}</Button>
      )}
      <Message text={state.message} />
    </div>
  );
}

/**
 * Opens the admin's invite under its one-time passphrase and makes a passport
 * under the user's own. Two clicks: opening takes a few seconds of key
 * stretching, and the browser only shows the save picker straight after a click.
 */
export function InviteForm({ db, root, flow, onDone, onCancel }: { db: KeyValueDb; root: FileSystemDirectoryHandle; flow: Flow; onDone: (identity: Identity) => Promise<void>; onCancel?: () => void }) {
  const { strings } = useShell();
  const { services } = flow;
  const [file, setFile] = useState<File | undefined>();
  const [invitePassphrase, setInvitePassphrase] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [made, setMade] = useState<{ passportText: string; fileName: string; identity: Identity } | undefined>();

  const open = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!file) return setMessage(strings.chooseInviteFirst);
    if (newPassphrase !== confirm) return setMessage(strings.passphrasesDiffer);
    setBusy(true);
    setMessage(undefined);
    try {
      const { passportText, fileName } = await services.enrol({ inviteText: await file.text(), invitePassphrase, newPassphrase });
      // Checked against this folder before anything is saved, so a wrong folder is found now.
      const identity = await services.unlock({ passportText, passphrase: newPassphrase, workspaceText: await services.readWorkspaceFile(root) });
      setMade({ passportText, fileName, identity });
    } catch (error: unknown) {
      setMessage(describeError(error, strings));
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!made) return;
    setBusy(true);
    try {
      const saved = await services.savePassport(db, made);
      if (saved.status === "none") setMessage(strings.passportNotSaved);
      else await onDone(made.identity);
    } catch (error: unknown) {
      setMessage(describeError(error, strings));
    } finally {
      setBusy(false);
    }
  };

  if (made) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm">{strings.inviteAccepted(made.identity.user.name)}</p>
        <Button id="save-passport" className="self-start" disabled={busy} onClick={() => void save()}>
          {strings.savePassport}
        </Button>
        <Message text={message} />
      </div>
    );
  }
  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void open(event)}>
      <Field label={strings.inviteFile}>
        <input id="invite-file" type="file" accept=".json,application/json" className="text-sm" onChange={(event) => setFile(event.target.files?.[0])} />
      </Field>
      <Field label={strings.invitePassphrase}>
        <input id="invite-passphrase" type="password" className={inputClass} value={invitePassphrase} onChange={(event) => setInvitePassphrase(event.target.value)} />
      </Field>
      <Field label={strings.newPassphrase}>
        <input id="new-passphrase" type="password" autoComplete="new-password" className={inputClass} value={newPassphrase} onChange={(event) => setNewPassphrase(event.target.value)} />
      </Field>
      <Field label={strings.confirmPassphrase}>
        <input id="confirm-passphrase" type="password" autoComplete="new-password" className={inputClass} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button id="open-invite" type="submit" disabled={busy}>
          {busy ? strings.openingInvite : strings.openInvite}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            {strings.cancel}
          </Button>
        )}
      </div>
      <Message text={message} />
    </form>
  );
}

export function PassportStep({ state, flow }: { state: Phase<"passport">; flow: Flow }) {
  const { strings } = useShell();
  const { db, root } = state;
  const [inviting, setInviting] = useState(false);

  if (inviting) return <InviteForm db={db} root={root} flow={flow} onDone={(identity) => flow.start(db, root, identity)} onCancel={() => setInviting(false)} />;
  const choose = async (): Promise<void> => {
    try {
      flow.dispatch({ type: "passport", passport: await flow.services.pickPassport(db) });
    } catch (error: unknown) {
      flow.dispatch({ type: "message", message: describeError(error, strings) });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">{strings.passportIntro(flow.config.name)}</p>
      <div className="flex gap-2">
        <Button id="have-invite" onClick={() => setInviting(true)}>
          {strings.haveInvite}
        </Button>
        <Button id="have-passport" variant="outline" onClick={() => void choose()}>
          {strings.havePassport}
        </Button>
      </div>
      <Message text={state.message} />
    </div>
  );
}

export function UnlockStep({ state, flow }: { state: Phase<"unlock">; flow: Flow }) {
  const { strings } = useShell();
  const { services } = flow;
  const { db, root } = state;
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      // Asked first, while the click still counts as the user's.
      const passport = state.passport.status === "ready" ? state.passport : await services.regrantPassport(state.passport.handle);
      if (passport.status !== "ready") return flow.dispatch({ type: "passport", passport, message: strings.allowPassport });
      const identity = await services.unlock({ passportText: await services.readPassport(passport.handle), passphrase, workspaceText: await services.readWorkspaceFile(root) });
      if (state.passport !== passport) flow.dispatch({ type: "passport", passport });
      await flow.start(db, root, identity);
    } catch (error: unknown) {
      flow.dispatch({ type: "message", message: describeError(error, strings) });
    } finally {
      setBusy(false);
    }
  };
  const other = async (): Promise<void> => {
    await services.forgetPassport(db);
    flow.dispatch({ type: "passport", passport: { status: "none" } });
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
      <Field label={strings.passphraseFor(state.passport.handle.name)}>
        <input id="passphrase" type="password" autoComplete="current-password" autoFocus className={inputClass} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button id="unlock" type="submit" disabled={busy}>
          {busy ? strings.unlocking : strings.unlock}
        </Button>
        <Button id="switch-passport" type="button" variant="outline" onClick={() => void other()}>
          {strings.switchPassport}
        </Button>
      </div>
      <Message text={state.message} />
    </form>
  );
}

export function AlreadyOpen({ state, flow }: { state: Phase<"already-open">; flow: Flow }) {
  const { strings } = useShell();
  const [busy, setBusy] = useState(false);
  const retry = async (): Promise<void> => {
    setBusy(true);
    try {
      await flow.start(state.db, state.root, state.identity);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div id="already-open" className="flex flex-col items-start gap-3">
      <p className="text-sm">{strings.alreadyOpen(flow.config.name)}</p>
      <Button disabled={busy} onClick={() => void retry()}>
        {strings.tryAgain}
      </Button>
    </div>
  );
}

export function Failed({ state }: { state: Phase<"failed"> }) {
  const { strings } = useShell();
  return (
    <div id="shell-failed" role="alert" className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
      <h2 className="font-semibold text-destructive">{strings.errorTitle}</h2>
      <p className="text-sm">{state.message}</p>
      {state.detail && <p className="text-sm break-all text-muted-foreground">{state.detail}</p>}
    </div>
  );
}
