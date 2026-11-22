// <TrellisApp>: every first-run state, found by role and label (spec S4,
// Deliver 1; plan section 3.2). Side effects are fakes; the real ones are
// covered by the from-disk smoke test.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { TrellisApp } from "../app-shell";
import { defaultStrings as s } from "../strings";
import { KeyFileError } from "../../identity/keyfile.js";
import { DEVICE, FOLDER, fakeServices, folderHandle, passportHandle, PASSPORT_FILE, USER, type Fakes } from "./helpers/fake-services";
import type { AppDefinition } from "../../definition";
import { useCommand, useConflicts, useRecords } from "../../../react/hooks";

const config: AppDefinition = { id: "test-app", name: "Test App", tables: {} };
const lapsed = { status: "needs-permission", handle: folderHandle } as const;
const remembered = { status: "ready", handle: passportHandle } as const;

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function show(fakes: Fakes, children = <p>the app's screen</p>) {
  render(
    <TrellisApp config={config} services={fakes.services}>
      {children}
    </TrellisApp>,
  );
  return fakes;
}

const screenShown = () => screen.findByText("the app's screen");
const button = (name: string | RegExp) => screen.findByRole("button", { name });

async function unlockWith(passphrase: string) {
  fireEvent.change(await screen.findByLabelText(s.passphraseFor(PASSPORT_FILE)), { target: { value: passphrase } });
  fireEvent.click(screen.getByRole("button", { name: s.unlock }));
}

describe("starting", () => {
  test("shows Starting until the local store and the folder are looked up", async () => {
    show(fakeServices({ openDb: () => new Promise(() => undefined) }));
    expect(screen.getByRole("status").textContent).toBe(s.starting);
    expect(screen.queryByText("the app's screen")).toBeNull();
  });

  test("start-up runs once per page however often React mounts", async () => {
    const fakes = fakeServices({ loadFolder: async () => ({ status: "none" }) });
    render(
      <StrictMode>
        <TrellisApp config={config} services={fakes.services} />
      </StrictMode>,
    );
    await button(s.chooseFolder);
    cleanup();
    render(<TrellisApp config={config} services={fakes.services} />);
    await button(s.chooseFolder);
    expect(fakes.calls.filter((name) => name === "openDb")).toEqual(["openDb"]);
  });
});

describe("folder", () => {
  test("none: choose the shared folder; a cancelled picker stays", async () => {
    let picked = false;
    const fakes = show(fakeServices({ loadFolder: async () => ({ status: "none" }), pickFolder: async () => (picked ? { status: "ready", handle: folderHandle } : { status: "none" }) }));
    fireEvent.click(await button(s.chooseFolder));
    await waitFor(() => expect(fakes.calls).toContain("pickFolder"));
    expect(await button(s.chooseFolder)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    picked = true;
    fireEvent.click(await button(s.chooseFolder));
    expect(await button(s.haveInvite)).toBeTruthy();
  });

  test("needs permission: reconnect to the folder by name; refused stays with its message", async () => {
    let grant = false;
    show(fakeServices({ loadFolder: async () => lapsed, regrant: async () => (grant ? { status: "ready", handle: folderHandle } : lapsed) }));
    fireEvent.click(await button(s.reconnectTo(FOLDER)));
    expect((await screen.findByRole("alert")).textContent).toBe(s.folderRefused);
    grant = true;
    fireEvent.click(await button(s.reconnectTo(FOLDER)));
    expect(await button(s.haveInvite)).toBeTruthy();
  });
});

describe("invite", () => {
  async function fillInvite(passphrase = "invite pass") {
    fireEvent.click(await button(s.haveInvite));
    const file = new File(["invite"], "sam.invite.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText(s.inviteFile), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText(s.invitePassphrase), { target: { value: passphrase } });
    fireEvent.change(screen.getByLabelText(s.newPassphrase), { target: { value: "my own passphrase" } });
    fireEvent.change(screen.getByLabelText(s.confirmPassphrase), { target: { value: "my own passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: s.openInvite }));
  }

  test("no passport: an invite or a passport is offered", async () => {
    show(fakeServices());
    expect(await screen.findByText(s.passportIntro(config.name))).toBeTruthy();
    expect(await button(s.haveInvite)).toBeTruthy();
    expect(await button(s.havePassport)).toBeTruthy();
  });

  test("invite accepted: save the passport, then the app's screens", async () => {
    const fakes = show(fakeServices());
    await fillInvite();
    expect(await screen.findByText(s.inviteAccepted(USER))).toBeTruthy();
    fireEvent.click(await button(s.savePassport));
    await screenShown();
    expect(fakes.calls).toEqual(expect.arrayContaining(["enrol", "unlock", "savePassport", "startHost"]));
  });

  test("wrong invite passphrase stays with its message", async () => {
    const wrong = new KeyFileError("wrong-passphrase", "invite");
    show(fakeServices({ enrol: async () => Promise.reject(wrong) }));
    await fillInvite("not it");
    expect((await screen.findByRole("alert")).textContent).toBe(wrong.message);
    expect(screen.getByRole("button", { name: s.openInvite })).toBeTruthy();
  });

  test("passport save cancelled stays with its message", async () => {
    show(fakeServices({ savePassport: async () => ({ status: "none" }) }));
    await fillInvite();
    fireEvent.click(await button(s.savePassport));
    expect((await screen.findByRole("alert")).textContent).toBe(s.passportNotSaved);
  });

  test("the two new passphrases must match", async () => {
    show(fakeServices());
    fireEvent.click(await button(s.haveInvite));
    fireEvent.change(screen.getByLabelText(s.inviteFile), { target: { files: [new File(["x"], "x.json")] } });
    fireEvent.change(screen.getByLabelText(s.newPassphrase), { target: { value: "one passphrase" } });
    fireEvent.change(screen.getByLabelText(s.confirmPassphrase), { target: { value: "another one" } });
    fireEvent.click(screen.getByRole("button", { name: s.openInvite }));
    expect((await screen.findByRole("alert")).textContent).toBe(s.passphrasesDiffer);
  });

  test("I have a passport: chosen, then asks for its passphrase", async () => {
    show(fakeServices());
    fireEvent.click(await button(s.havePassport));
    expect(await screen.findByLabelText(s.passphraseFor(PASSPORT_FILE))).toBeTruthy();
  });
});

describe("unlock", () => {
  test("wrong passphrase stays with its message; the right one opens the app", async () => {
    const wrong = new KeyFileError("wrong-passphrase", "passport");
    let right = false;
    show(fakeServices({ loadPassport: async () => remembered, unlock: async (args) => (right ? fakeServices().services.unlock(args) : Promise.reject(wrong)) }));
    await unlockWith("not it");
    expect((await screen.findByRole("alert")).textContent).toBe(wrong.message);
    right = true;
    await unlockWith("my own passphrase");
    await screenShown();
  });

  test("passport permission refused stays with its message", async () => {
    show(fakeServices({ loadPassport: async () => ({ status: "needs-permission", handle: passportHandle }), regrantPassport: async () => ({ status: "needs-permission", handle: passportHandle }) }));
    await unlockWith("my own passphrase");
    expect((await screen.findByRole("alert")).textContent).toBe(s.allowPassport);
  });

  test("use another passport or an invite", async () => {
    const fakes = show(fakeServices({ loadPassport: async () => remembered }));
    fireEvent.click(await button(s.switchPassport));
    expect(await button(s.haveInvite)).toBeTruthy();
    expect(fakes.calls).toContain("forgetPassport");
  });
});

describe("already open", () => {
  test("its own screen; Try again once the other tab is closed", async () => {
    let open = true;
    const fakes = fakeServices({ loadPassport: async () => remembered });
    const real = fakes.services.startHost;
    fakes.services.startHost = async (cfg) => (open ? { ok: false, reason: "already-open" } : real(cfg));
    show(fakes);
    await unlockWith("my own passphrase");
    expect(await screen.findByText(s.alreadyOpen(config.name))).toBeTruthy();
    fireEvent.click(await button(s.tryAgain));
    expect(await screen.findByText(s.alreadyOpen(config.name))).toBeTruthy();
    open = false;
    fireEvent.click(await button(s.tryAgain));
    await screenShown();
  });
});

describe("running", () => {
  async function running(overrides = {}) {
    const fakes = show(fakeServices({ loadPassport: async () => remembered, ...overrides }));
    await unlockWith("my own passphrase");
    await screenShown();
    return { ...fakes, engine: fakes.engines[0]! };
  }

  test("the health indicator, the app's screens, who and where, and the version", async () => {
    await running();
    expect(screen.getByRole("button", { name: s.health.saved.label })).toBeTruthy();
    expect(screen.getByText(s.signedIn(USER, DEVICE, FOLDER))).toBeTruthy();
    expect(screen.getByText(s.version(__APP_VERSION__, __BUILT_AT__))).toBeTruthy();
  });

  test("checks for updates once the folder is connected", async () => {
    const checkForUpdate = vi.fn(async () => ({ status: "current", version: "1" }) as const);
    await running({ loader: () => ({ checkForUpdate }) as never });
    expect(checkForUpdate).toHaveBeenCalledWith(folderHandle);
  });

  test("shows the update notice from the loader", async () => {
    const onUpdate = (listener: (result: { status: "updated"; version: string }) => void) => (listener({ status: "updated", version: "9.9.9" }), () => undefined);
    await running({ loader: () => ({ checkForUpdate: async () => ({ status: "current", version: "1" }), onUpdate }) as never });
    expect(screen.getByText(s.updateReady("9.9.9"))).toBeTruthy();
  });

  test("an error in the app's screens shows the error screen", async () => {
    const Broken = (): never => {
      throw new TypeError("table went missing");
    };
    show(fakeServices({ loadPassport: async () => remembered }), <Broken />);
    await unlockWith("my own passphrase");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: s.errorTitle })).toBeTruthy();
    expect(within(alert).getByRole("button", { name: s.openDiagnostics })).toBeTruthy();
  });

  test("Open a new invite restarts the engine with the new keys", async () => {
    const { calls } = await running();
    fireEvent.click(await button(s.newInvite));
    fireEvent.change(screen.getByLabelText(s.inviteFile), { target: { files: [new File(["x"], "x.json")] } });
    fireEvent.change(screen.getByLabelText(s.newPassphrase), { target: { value: "my own passphrase" } });
    fireEvent.change(screen.getByLabelText(s.confirmPassphrase), { target: { value: "my own passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: s.openInvite }));
    fireEvent.click(await button(s.savePassport));
    await waitFor(() => expect(calls.filter((name) => name === "startHost")).toHaveLength(2));
    expect(calls).toContain("stop");
    await screenShown();
  });
});

describe("folder permission lost mid-session", () => {
  async function disconnected(regrantResult: "granted" | "refused") {
    const fakes = fakeServices({
      loadPassport: async () => remembered,
      folderPermission: async () => "prompt",
      regrant: async () => (regrantResult === "granted" ? { status: "ready", handle: folderHandle } : lapsed),
    });
    show(fakes);
    await unlockWith("my own passphrase");
    await screenShown();
    const engine = fakes.engines[0]!;
    act(() => engine.setHealth({ state: "folder-disconnected" }));
    const banner = await screen.findByRole("region", { name: s.reconnectTitle });
    return { fakes, engine, banner };
  }

  test("a banner says changes are safe here, with Reconnect; the screens stay", async () => {
    const { banner } = await disconnected("granted");
    expect(within(banner).getByText(s.reconnectBanner(FOLDER))).toBeTruthy();
    expect(within(banner).getByRole("button", { name: s.reconnect })).toBeTruthy();
    expect(screen.getByText("the app's screen")).toBeTruthy();
  });

  test("clears after permission is granted and the next folder operation succeeds", async () => {
    const { engine, banner, fakes } = await disconnected("granted");
    fireEvent.click(within(banner).getByRole("button", { name: s.reconnect }));
    expect(await within(banner).findByText(s.reconnected)).toBeTruthy();
    expect(fakes.calls).toContain("regrant");
    expect(engine.calls).toContain("scan");
    expect(screen.getByRole("region", { name: s.reconnectTitle })).toBeTruthy();
    act(() => engine.setHealth({ state: "saved" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: s.reconnectTitle })).toBeNull());
  });

  test("refused stays with its message", async () => {
    const { banner } = await disconnected("refused");
    fireEvent.click(within(banner).getByRole("button", { name: s.reconnect }));
    expect((await within(banner).findByRole("alert")).textContent).toBe(s.folderRefused);
    expect(within(banner).getByRole("button", { name: s.reconnect })).toBeTruthy();
  });

  test("no banner while the folder still has permission", async () => {
    const fakes = show(fakeServices({ loadPassport: async () => remembered }));
    await unlockWith("my own passphrase");
    await screenShown();
    act(() => fakes.engines[0]!.setHealth({ state: "folder-disconnected" }));
    await waitFor(() => expect(fakes.calls).toContain("folderPermission"));
    expect(screen.queryByRole("region", { name: s.reconnectTitle })).toBeNull();
  });
});

describe("failed", () => {
  test("local storage unavailable shows the error screen", async () => {
    show(fakeServices({ openDb: async () => Promise.reject(new DOMException("blocked", "UnknownError")) }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: s.errorTitle })).toBeTruthy();
    expect(within(alert).getByText(s.storageUnavailable)).toBeTruthy();
    expect(within(alert).getByText("UnknownError: blocked")).toBeTruthy();
  });
});

test("an empty shell: tables {} and no screens reaches the running state", async () => {
  const fakes = fakeServices({ loadPassport: async () => remembered });
  render(<TrellisApp config={{ id: "empty", name: "Empty", tables: {} }} services={fakes.services} />);
  fireEvent.change(await screen.findByLabelText(s.passphraseFor(PASSPORT_FILE)), { target: { value: "my own passphrase" } });
  fireEvent.click(screen.getByRole("button", { name: s.unlock }));
  expect(await screen.findByRole("button", { name: s.health.saved.label })).toBeTruthy();
});

test("an app rewords the first-run flow through the strings prop", async () => {
  const fakes = fakeServices({ loadFolder: async () => ({ status: "none" }) });
  render(<TrellisApp config={config} services={fakes.services} strings={{ chooseFolder: "Pick the team folder" }} />);
  expect(await button("Pick the team folder")).toBeTruthy();
});

describe("data", () => {
  // The test app's own table; cast because row types come from the example app's Register.
  const items = "items" as never;
  const withTable: AppDefinition = { id: "test-app", name: "Test App", tables: { items: { version: 1, fields: { label: "latest" } } } };

  function Items() {
    const rows = useRecords(items) as readonly { id: string; label?: string }[];
    const create = useCommand("records.create");
    const conflicts = useConflicts();
    return (
      <>
        <p>{rows.map((row) => row.label).join(", ") || "no items"}</p>
        <p>{`${conflicts.length} conflicts`}</p>
        <button onClick={() => create({ table: items, fields: { label: "first" } })}>add</button>
      </>
    );
  }

  test("once running, screens read with hooks and write with commands", async () => {
    const fakes = fakeServices({ loadPassport: async () => remembered });
    render(
      <TrellisApp config={withTable} services={fakes.services}>
        <Items />
      </TrellisApp>,
    );
    await unlockWith("my own passphrase");
    expect(await screen.findByText("no items")).toBeTruthy();
    expect(screen.getByText("0 conflicts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    expect(await screen.findByText("first")).toBeTruthy();
  });
});
