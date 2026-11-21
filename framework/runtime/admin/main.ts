// The admin page (S3 deliverables 4 and 5, plan section 4 OUT-10): one HTML
// file, opened from disk, that does not go through the loader. It creates the
// workspace, invites people, marks them inactive, rotates the key and exports
// the key backup. It keeps no key in the browser (decision D7): every session
// starts from the key backup and its passphrase, and the keyring lives in this
// page's memory only. Its own database holds the folder handle, the device id
// and the engine's local state, so it and the app can be open together.
import { loadFolder, pickFolder, regrant, type FolderState } from "../host/folder";
import { openDb, type KeyValueDb } from "../host/idb";
import { startHost } from "../host/host";
import type { Engine } from "../host/engine-types";
import { appNames } from "../names";
import { openTable } from "../../engine/src/records/index.js";
import { KeyFileError } from "../identity/keyfile.js";
import { workspaceFileFor } from "../identity/workspace.js";
import { newKeyring, rotateKeyring, userIdFor, mintInvite, exportBackup, engineKeys, USERS_TABLE, USERS_SCHEMA, putUser } from "../identity/admin.js";
import { readWorkspace, writeWorkspace, openKeyring, AdminError, backupFileName, inviteFileName } from "./actions.js";

type Keyring = { workspace: string; current: number; keys: { id: number; raw: Uint8Array }[] };
type UserFields = { name: string; role: string; status: string };
type UsersTable = { list(): { id: string; fields: UserFields }[] };
type Unreadable = { path: string; error?: { name: string; message: string } };
type Session = { root: FileSystemDirectoryHandle; keyring: Keyring; engine: Engine; users: UsersTable; stop: () => Promise<void> };

const names = appNames(__APP_DEFINITION__);
// The engine writes as the admin page, not as a person: the backup holds no user.
const ENGINE_USER = "admin";
const REFRESH_MS = 2000;
const REMOVAL_NOTE = "Removing a user means rotating the key and giving every remaining user a new invite.";
const random = { bytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)), float: () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32 };

const page = document.getElementById("admin") as HTMLElement;
let refreshTimer: number | undefined;
document.title = `${names.title} admin`;

// ---- small DOM helpers ----

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { id?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const message = el("p", { id: "admin-message", role: "status" } as Partial<HTMLParagraphElement>);
const say = (text: string): void => void (message.textContent = text);

function field(id: string, label: string, type = "text"): HTMLInputElement {
  return el("input", { id, type, autocomplete: "off", ...({ "aria-label": label } as object) });
}
const labelled = (input: HTMLInputElement, text: string): HTMLElement[] => [el("label", { htmlFor: input.id }, text), input];

function show(...children: (Node | string)[]): void {
  say("");
  page.replaceChildren(el("h1", {}, `${names.title} admin`), ...children, message);
}

/** Runs an action from a click, showing any error as a message instead of throwing (plan 4, OUT-10 step 5). */
function act(button: HTMLButtonElement, run: () => Promise<void>): void {
  button.addEventListener("click", () => {
    button.disabled = true;
    run()
      .catch((error: unknown) => say(error instanceof KeyFileError || error instanceof AdminError ? error.message : error instanceof Error ? `${error.name}: ${error.message}` : String(error)))
      .finally(() => (button.disabled = false));
  });
}

function fileUrl(text: string): string {
  return URL.createObjectURL(new Blob([text], { type: "application/json" }));
}

/** A link the admin clicks to save a file; `onSaved` runs on that click. */
function downloadLink(id: string, fileName: string, text: string, onSaved: () => void): HTMLAnchorElement {
  const link = el("a", { id, className: "download", href: fileUrl(text), download: fileName }, `Download ${fileName}`);
  link.addEventListener("click", onSaved);
  return link;
}

/** Saves a file straight away, for files that can be made again (invites, extra backups). */
function download(fileName: string, text: string): void {
  const link = el("a", { href: fileUrl(text), download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
}

const checkPassphrases = (a: HTMLInputElement, b: HTMLInputElement): void => {
  if (a.value !== b.value) throw new Error("The two passphrases are different.");
};

// ---- the folder ----

async function start(): Promise<void> {
  const db = await openDb(names.adminDatabase);
  let folder: FolderState = await loadFolder(db);
  const button = el("button", { id: "admin-folder" }, folder.status === "none" ? "Choose the shared folder" : `Connect to "${folder.handle.name}"`);
  act(button, async () => {
    folder = folder.status === "none" ? await pickFolder(db, `${names.folderPicker}-admin`) : folder.status === "needs-permission" ? await regrant(folder.handle) : folder;
    if (folder.status === "ready") await connected(db, folder.handle);
  });
  const other = el("button", { id: "admin-other-folder" }, "Choose another folder");
  act(other, async () => {
    folder = await pickFolder(db, `${names.folderPicker}-admin`);
    if (folder.status === "ready") await connected(db, folder.handle);
  });
  show(el("p", {}, `Choose the shared ${names.title} folder to create or manage its workspace.`), button, ...(folder.status === "none" ? [] : [other]));
}

async function connected(db: KeyValueDb, root: FileSystemDirectoryHandle): Promise<void> {
  const found = await readWorkspace(root);
  if (found.status === "missing") return createScreen(db, root);
  if (found.status === "found") return openScreen(db, root, found.text);
  const retry = el("button", { id: "admin-retry" }, "Try again");
  act(retry, () => connected(db, root));
  show(el("p", {}, `The workspace file in "${root.name}" could not be read: ${found.message}`), retry);
}

// ---- create ----

function createScreen(db: KeyValueDb, root: FileSystemDirectoryHandle): void {
  const name = field("admin-name", "Your name");
  const pass = field("admin-pass", "Key backup passphrase", "password");
  const again = field("admin-pass-again", "The passphrase again", "password");
  const create = el("button", { id: "admin-create" }, "Create the workspace");
  const step = el("div");
  act(create, async () => {
    if (name.value.trim() === "") throw new Error("Enter your name.");
    checkPassphrases(pass, again);
    const keyring: Keyring = newKeyring({ random });
    const backup = await exportBackup({ keyring, passphrase: pass.value, random });
    pass.value = again.value = "";
    const finish = el("button", { id: "admin-finish", disabled: true }, "Finish");
    act(finish, async () => {
      // Someone may have created a workspace here meanwhile; never overwrite it.
      if ((await readWorkspace(root)).status !== "missing") throw new Error("This folder now has a workspace. Reload the page and open it.");
      await writeWorkspace(root, await workspaceFileFor(keyring, { random }));
      const session = await startSession(db, root, keyring);
      if (!session) return;
      putUser(session.users, { id: userIdFor(name.value, []), name: name.value.trim(), role: "admin", status: "active" });
      await session.engine.flush();
      workspaceScreen(db, session, "The workspace is created. Keep the key backup and its passphrase safe: they are the only way back in here.");
    });
    create.hidden = true;
    step.replaceChildren(
      el("p", { className: "note" }, "Download the key backup and keep it somewhere safe, away from the shared folder. Without it, or a user's passport, nobody can manage this workspace."),
      downloadLink("admin-backup", backupFileName(keyring), backup, () => void (finish.disabled = false)),
      finish,
    );
  });
  show(
    el("p", {}, `"${root.name}" has no workspace yet. Create one: this makes the workspace key and a key backup protected by a passphrase you choose.`),
    ...labelled(name, "Your name"),
    ...labelled(pass, "Key backup passphrase (at least 12 characters)"),
    ...labelled(again, "The passphrase again"),
    create,
    step,
  );
}

// ---- open ----

function openScreen(db: KeyValueDb, root: FileSystemDirectoryHandle, workspaceText: string): void {
  const file = el("input", { id: "admin-file", type: "file", accept: ".json,application/json" });
  const pass = field("admin-open-pass", "Passphrase", "password");
  const open = el("button", { id: "admin-open" }, "Open");
  const repair = el("div");
  act(open, async () => {
    const chosen = file.files?.[0];
    if (!chosen) throw new Error("Choose the key backup file.");
    repair.replaceChildren();
    try {
      const { keyring, from } = await openKeyring({ text: await chosen.text(), passphrase: pass.value, workspaceText });
      const session = await startSession(db, root, keyring);
      if (session) workspaceScreen(db, session, from === "passport" ? "Opened from a passport. Download a new key backup below and keep it safe." : "");
    } catch (error) {
      if (!(error instanceof AdminError && error.code === "bad-workspace")) throw error;
      const keyring = (error as AdminError & { keyring: Keyring }).keyring;
      const rewrite = el("button", { id: "admin-repair" }, "Rewrite workspace.json from this key file");
      act(rewrite, async () => {
        await writeWorkspace(root, await workspaceFileFor(keyring, { random }));
        const session = await startSession(db, root, keyring);
        if (session) workspaceScreen(db, session, "workspace.json is rewritten.");
      });
      repair.replaceChildren(rewrite);
      throw error;
    } finally {
      pass.value = "";
    }
  });
  show(
    el("p", {}, `"${root.name}" already has a workspace. Open it with the key backup and its passphrase. If the backup is lost, any user's passport and their passphrase also open it.`),
    ...labelled(file, "Key backup (or a passport)"),
    ...labelled(pass, "Its passphrase"),
    open,
    repair,
  );
}

// ---- the open workspace ----

async function startSession(db: KeyValueDb, root: FileSystemDirectoryHandle, keyring: Keyring): Promise<Session | null> {
  const started = await startHost({ root, db, user: ENGINE_USER, ...(await engineKeys(keyring)), app: __APP_DEFINITION__ });
  if (!started.ok) {
    say("The admin page is already open in another tab. Use that tab, or close it and try again.");
    return null;
  }
  const users = openTable({ adapter: undefined, doc: started.engine.table(USERS_TABLE), schema: USERS_SCHEMA, deviceId: started.deviceId, user: ENGINE_USER, clock: { now: () => Date.now() } }) as unknown as UsersTable;
  return { root, keyring, engine: started.engine, users, stop: started.stop };
}

function workspaceScreen(db: KeyValueDb, session: Session, opening: string): void {
  const { keyring, engine, users } = session;
  const userRows = el("tbody");
  const problems = el("ul", { id: "admin-problems" });
  const invitePass = field("admin-invite-pass", "One-time invite passphrase", "password");

  async function invite(id: string, name: string, role: string): Promise<void> {
    const text = await mintInvite({ keyring, user: { id, name }, passphrase: invitePass.value, random });
    download(inviteFileName(id), text);
    putUser(users, { id, name, role, status: "active" });
    await engine.flush();
    refresh();
    say(`Invite for ${name} saved as ${inviteFileName(id)}. Give them the file, and the passphrase separately.`);
  }

  function refresh(): void {
    userRows.replaceChildren(
      ...users.list().map(({ id, fields }) => {
        const actions = el("td");
        if (fields.status === "active") {
          const again = el("button", {}, "New invite");
          act(again, () => invite(id, fields.name, fields.role));
          const off = el("button", {}, "Mark inactive");
          act(off, async () => {
            putUser(users, { id, ...fields, status: "inactive" });
            await engine.flush();
            refresh();
            say(`${fields.name} is marked inactive. ${REMOVAL_NOTE}`);
          });
          actions.append(again, off);
        }
        const row = el("tr", {}, el("td", {}, fields.name), el("td", {}, id), el("td", {}, fields.role), el("td", {}, fields.status), actions);
        row.dataset.user = id;
        return row;
      }),
    );
    const unreadable = (engine as unknown as { status(): { unreadable: Unreadable[] } }).status().unreadable;
    problems.replaceChildren(
      ...(unreadable.length ? unreadable.map((u) => el("li", {}, u.path, el("span", { className: "muted" }, u.error ? ` (${u.error.name}: ${u.error.message})` : ""))) : [el("li", { className: "muted" }, "None.")]),
    );
  }

  const newName = field("admin-user-name", "Name");
  const add = el("button", { id: "admin-invite" }, "Invite");
  act(add, async () => {
    if (newName.value.trim() === "") throw new Error("Enter the user's name.");
    const id = userIdFor(newName.value, users.list().map((u) => u.id));
    await invite(id, newName.value.trim(), "member");
    newName.value = "";
  });

  const keyPass = field("admin-key-pass", "Key backup passphrase", "password");
  const keyAgain = field("admin-key-pass-again", "The passphrase again", "password");
  const keyStep = el("div");
  const backupNow = el("button", { id: "admin-download-backup" }, "Download a key backup");
  act(backupNow, async () => {
    checkPassphrases(keyPass, keyAgain);
    download(backupFileName(keyring), await exportBackup({ keyring, passphrase: keyPass.value, random }));
    keyPass.value = keyAgain.value = "";
    say(`Key backup saved as ${backupFileName(keyring)}.`);
  });
  const rotate = el("button", { id: "admin-rotate" }, "Rotate the key");
  act(rotate, async () => {
    checkPassphrases(keyPass, keyAgain);
    const rotated: Keyring = rotateKeyring(keyring, { random });
    const backup = await exportBackup({ keyring: rotated, passphrase: keyPass.value, random });
    keyPass.value = keyAgain.value = "";
    const finish = el("button", { id: "admin-finish-rotation", disabled: true }, "Finish rotation");
    act(finish, async () => {
      // The new backup is saved first; only then does the folder learn of the new key.
      await engine.flush();
      await writeWorkspace(session.root, await workspaceFileFor(rotated, { random }));
      await session.stop();
      const next = await startSession(db, session.root, rotated);
      if (next) workspaceScreen(db, next, `Key ${rotated.current} is now the current key. Every remaining user needs a new invite: use "New invite" on each row.`);
    });
    keyStep.replaceChildren(
      el("p", { className: "note" }, `Download the new key backup first. Rotation finishes once it is saved; until then nothing in the folder changes.`),
      downloadLink("admin-rotation-backup", backupFileName(rotated), backup, () => void (finish.disabled = false)),
      finish,
    );
  });

  window.clearInterval(refreshTimer); // the screen from before a rotation
  refreshTimer = window.setInterval(() => {
    try {
      refresh();
    } catch (error) {
      say(`The users list could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, REFRESH_MS);
  show(
    el("p", { id: "admin-workspace" }, `Workspace ${keyring.workspace} in "${session.root.name}". Current key: ${keyring.current}.`),
    ...(opening ? [el("p", { className: "note" }, opening)] : []),
    el("h2", {}, "Users"),
    el("table", {}, el("thead", {}, el("tr", {}, ...["Name", "Id", "Role", "Status", ""].map((h) => el("th", {}, h)))), userRows),
    el("p", { className: "note" }, REMOVAL_NOTE),
    el("h2", {}, "Invite a user"),
    ...labelled(newName, "Name"),
    ...labelled(invitePass, "One-time passphrase for the invite (at least 12 characters; also used by \"New invite\")"),
    add,
    el("h2", {}, "Workspace key"),
    ...labelled(keyPass, "Passphrase for the new key backup"),
    ...labelled(keyAgain, "The passphrase again"),
    backupNow,
    rotate,
    keyStep,
    el("h2", {}, "Files that could not be read"),
    problems,
  );
  refresh();
}

start().catch((error: unknown) => {
  page.replaceChildren(el("p", { id: "admin-message" }, `${names.title} admin could not start: ${error instanceof Error ? error.message : String(error)}`));
});
