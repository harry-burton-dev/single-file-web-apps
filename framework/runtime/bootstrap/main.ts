// The bootstrap (ADR-0005 section 5): the only code in the bootstrap page. It runs
// the last bundle it verified, or asks for the shared folder on a first run,
// and accepts new bundles only through the signed manifest. Kept small and
// free of the app's libraries: a mistake here needs the file handed out again.
import { loadFolder, pickFolder, regrant, type FolderState } from "../host/folder";
import { openDb, type KeyValueDb } from "../host/idb";
import { cachedBundle, checkForUpdate } from "../loader/loader.js";
import { updateReporter } from "../loader/updates.js";
import { importPublicKey } from "../loader/manifest.js";
import { BOOTSTRAP_VERSION, type LoaderServices, type UpdateResult } from "../loader/contract";
import { appNames } from "../names";

// The app's id and name come from the build (__APP__), not from the app's config.
const names = appNames(__APP__);
const RECHECK_MS = 15 * 60 * 1000;
const previous = location.hash === "#previous";
const safe = location.hash === "#safe";

const app = document.getElementById("app") as HTMLElement;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, id?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (id) node.id = id;
  return node;
}

/** A small note in the corner, over whatever the app shows. */
function notice(text: string, action?: { label: string; run: () => void }): void {
  document.getElementById("boot-notice")?.remove();
  const box = element("div", text, "boot-notice");
  box.setAttribute("role", "status");
  if (action) {
    const button = element("button", action.label);
    button.addEventListener("click", action.run);
    box.append(button);
  }
  document.body.append(box);
}

async function boot(): Promise<void> {
  const db = await openDb(names.database);
  const publicKey = await importPublicKey(__SIGNING_PUBLIC_KEY__, crypto.subtle);
  const check = (root: FileSystemDirectoryHandle): Promise<UpdateResult> =>
    checkForUpdate({ root, cache: db, publicKey, subtle: crypto.subtle, bootstrapVersion: BOOTSTRAP_VERSION }) as Promise<UpdateResult>;

  const reporter = updateReporter({
    draw: (result: UpdateResult) => {
      if (result.status === "updated") notice(`Version ${result.version} is ready.`, { label: "Load it", run: () => location.reload() });
      if (result.status === "rejected") notice(result.message);
    },
    clear: () => document.getElementById("boot-notice")?.remove(),
  });

  let watching = false;
  /** Check now and report; after the first call, again every RECHECK_MS for as long as the page is open. */
  async function checkAndReport(root: FileSystemDirectoryHandle): Promise<UpdateResult> {
    const result = await check(root);
    reporter.report(result);
    if (!watching) {
      watching = true;
      window.setInterval(() => void checkAndReport(root), RECHECK_MS);
    }
    return result;
  }

  async function run(bundle: { version: string; bytes: Uint8Array }): Promise<void> {
    const url = URL.createObjectURL(new Blob([bundle.bytes as BlobPart], { type: "text/javascript" }));
    const module = (await import(/* @vite-ignore */ url)) as { start: (services: LoaderServices) => void | Promise<void> };
    app.replaceChildren();
    await module.start({ contract: 1, bootstrapVersion: BOOTSTRAP_VERSION, version: bundle.version, safe, mount: app, checkForUpdate: checkAndReport, onUpdate: reporter.subscribe });
  }

  const cached = await cachedBundle(db, { previous });
  if (cached) return run(cached);
  if (previous) return void app.replaceChildren(firstRun(db, check, run, "There is no previous version stored in this browser."));
  app.replaceChildren(firstRun(db, check, run));
}

/** No verified bundle in this browser yet: connect the folder, verify what it holds, run it. */
function firstRun(
  db: KeyValueDb,
  check: (root: FileSystemDirectoryHandle) => Promise<UpdateResult>,
  run: (bundle: { version: string; bytes: Uint8Array }) => Promise<void>,
  opening = `Connect the shared ${names.title} folder to load the app.`,
): HTMLElement {
  const box = element("div", "", "boot");
  const message = element("p", opening, "boot-message");
  const button = element("button", "Choose the shared folder", "boot-connect");
  box.append(element("h1", names.title), message, button);
  let folder: FolderState = { status: "none" };
  void loadFolder(db).then((found) => {
    folder = found;
    if (found.status !== "none") button.textContent = `Connect to "${found.handle.name}"`;
  });
  button.addEventListener("click", () => {
    void (async () => {
      try {
        folder = folder.status === "none" ? await pickFolder(db, names.folderPicker) : folder.status === "needs-permission" ? await regrant(folder.handle) : folder;
        if (folder.status !== "ready") return;
        const result = await check(folder.handle);
        const bundle = await cachedBundle(db);
        if (bundle) return await run(bundle);
        message.textContent = result.status === "rejected" ? result.message : "No version could be loaded from this folder.";
        folder = { status: "none" }; // let the user pick another folder
        button.textContent = "Choose the shared folder";
      } catch (error: unknown) {
        message.textContent = error instanceof Error ? `${error.name}: ${error.message}` : "Unexpected error";
      }
    })();
  });
  return box;
}

boot().catch((error: unknown) => {
  app.replaceChildren(element("p", `${names.title} could not start: ${error instanceof Error ? error.message : String(error)}`, "boot-message"));
});
