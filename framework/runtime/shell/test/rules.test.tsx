// The two rules every shell piece follows (spec S4, Deliver 3 and "Defaults
// chosen" 2): every word comes from the strings file, and no colour is
// written except through the project's design tokens.
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { defaultStrings, type ShellStringOverrides } from "../strings";
import { HealthIndicator, ShellProvider } from "../index";
import { clockTime } from "../format";
import { emptyMetrics, fakeEngine } from "./helpers/fake-engine";
import { HEALTH_STATES } from "../../../engine/src/engine/health.js";
import type { HealthState, Trace } from "../../host/engine-types";
import { TrellisApp } from "../app-shell";
import { PassportError } from "../../identity/passport.js";
import { DEVICE, FOLDER, fakeServices, folderHandle, PASSPORT_FILE, USER } from "./helpers/fake-services";
import type { UpdateResult } from "../../loader/contract";
import { ConflictPrompt } from "../conflict-prompt";
import { clockAndDate } from "../format";
import { DataProvider } from "../../../react/hooks";
import type { Data } from "../../../data/runtime";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Every string becomes ⟦its path⟧; every function returns ⟦its path:its arguments⟧. */
function sentinel<T>(value: T, path = ""): T {
  if (typeof value === "string") return `⟦${path}⟧` as T;
  if (typeof value === "function") return ((...args: unknown[]) => `⟦${path}:${args.join("|")}⟧`) as T;
  return Object.fromEntries(Object.entries(value as object).map(([key, inner]) => [key, sentinel(inner, path ? `${path}.${key}` : key)])) as T;
}

const MARKER = /⟦[^⟦⟧]*⟧/g;

/** What a person can read or hear: text, and the attributes that are spoken or shown. */
function wording(): string {
  const parts = [document.body.textContent ?? ""];
  for (const el of document.body.querySelectorAll("*")) {
    for (const name of ["aria-label", "title", "placeholder", "alt"]) {
      const value = el.getAttribute(name);
      if (value) parts.push(value);
    }
  }
  return parts.join(" ");
}

/** Strip the markers (innermost first) and the data the fixtures put on screen; no words may be left. */
function strayWords(text: string, data: string[]): string[] {
  let rest = text;
  while (MARKER.test(rest)) rest = rest.replace(MARKER, " ");
  for (const value of data) rest = rest.split(value).join(" ");
  return rest.match(/[A-Za-z]+/g) ?? [];
}

const trace: Trace = {
  id: 1,
  kind: "scan",
  startedAt: 0,
  durationMs: 5,
  outcome: "partial",
  reason: "timer",
  counts: {},
  steps: [{ at: 0, table: null, path: "x/9.bin", action: "read", bytes: 12, durationMs: 2, result: "done", error: null }],
};
const DATA = ["sam", "scan", "partial", "timer", "x/9.bin", "read", "done", "RangeError: boom", clockTime(0, "never")];
const peers = { d1: { user: "sam", lastHeardAt: 0, lastAckedAt: null, active: true, ackedLatest: false, waitingSince: null } };

test("sentinel strings: the indicator and its menu, in every state, use no other wording", () => {
  const strings = sentinel(defaultStrings);
  for (const state of HEALTH_STATES as HealthState[]) {
    render(
      <ShellProvider engine={fakeEngine({ state, extra: { pending: 2, lastSaveAt: 0, peers } })} strings={strings}>
        <HealthIndicator />
      </ShellProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(strayWords(wording(), DATA), state).toEqual([]);
    cleanup();
  }
  render(
    <ShellProvider strings={strings}>
      <HealthIndicator />
    </ShellProvider>,
  );
  expect(strayWords(wording(), DATA), "starting").toEqual([]);
});

test("sentinel strings: the diagnostics view uses no other wording", () => {
  const strings = sentinel(defaultStrings);
  const metrics = { ...emptyMetrics, sync: { save: { count: 1, lastMs: 3, avgMs: null, p95Ms: 4 }, scan: emptyMetrics.sync.scan } };
  render(
    <ShellProvider engine={fakeEngine({ traces: [trace], metrics })} strings={strings}>
      <HealthIndicator />
    </ShellProvider>,
  );
  fireEvent.click(screen.getByRole("button"));
  fireEvent.click(screen.getByRole("menuitem"));
  fireEvent.click(screen.getByRole("button", { name: /scan/ }));
  expect(screen.getByText("x/9.bin")).toBeTruthy();
  expect(strayWords(wording(), DATA)).toEqual([]);
  cleanup();
  render(
    <ShellProvider engine={fakeEngine({ traces: [{ ...trace, steps: [] }] })} strings={strings}>
      <HealthIndicator />
    </ShellProvider>,
  );
  fireEvent.click(screen.getByRole("button"));
  fireEvent.click(screen.getByRole("menuitem"));
  fireEvent.click(screen.getByRole("button", { name: /scan/ }));
  expect(strayWords(wording(), DATA)).toEqual([]);
});

test("sentinel strings: the error screen uses no other wording", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const Broken = (): never => {
    throw new RangeError("boom");
  };
  render(
    <ShellProvider engine={fakeEngine()} strings={sentinel(defaultStrings)}>
      <Broken />
    </ShellProvider>,
  );
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(strayWords(wording(), DATA)).toEqual([]);
});

test("sentinel strings: the update notice, ready and refused, uses no other wording", () => {
  const strings = sentinel(defaultStrings);
  for (const result of [
    { status: "updated", version: "1.1.0" },
    { status: "rejected", code: "signature-invalid", message: "refusal" },
  ] as UpdateResult[]) {
    render(<ShellProvider strings={strings} onUpdate={(listener) => (listener(result), () => undefined)} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(strayWords(wording(), [...DATA, "1.1.0", "refusal"]), result.status).toEqual([]);
    cleanup();
  }
});

test("sentinel strings: the conflict prompt, closed and open, uses no other wording", () => {
  const candidates = [
    { value: "Alpha", user: "harry", device: "harry-aaaaaaaa", writtenAt: 10 },
    { value: "Beta", user: "sam", device: "sam-bbbbbbbb", writtenAt: 20 },
  ];
  const list = [{ table: "notes", id: "n1", field: "room", value: "Beta", candidates }];
  const data = { conflicts: { subscribe: () => () => undefined, getSnapshot: () => list }, run: () => ({ ok: true }) } as unknown as Data;
  render(
    <ShellProvider strings={sentinel(defaultStrings)}>
      <DataProvider data={data}>
        <ConflictPrompt />
      </DataProvider>
    </ShellProvider>,
  );
  const shown = [...DATA, "notes", "n1", "room", "Alpha", "Beta", "harry", clockAndDate(10), clockAndDate(20)];
  expect(strayWords(wording(), shown), "closed").toEqual([]);
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByRole("group")).toBeTruthy();
  expect(strayWords(wording(), shown), "open").toEqual([]);
});

test("the sentinel check catches hard-coded wording", () => {
  render(<p>⟦a⟧ Saved</p>);
  expect(strayWords(wording(), DATA)).toEqual(["Saved"]);
});

test("an app rewords one entry and keeps the rest", () => {
  const strings: ShellStringOverrides = { health: { saved: { label: "All good" } } };
  render(
    <ShellProvider engine={fakeEngine()} strings={strings}>
      <HealthIndicator />
    </ShellProvider>,
  );
  expect(screen.getByRole("button", { name: "All good" })).toBeTruthy();
  expect(screen.getByText(defaultStrings.health.saved.sentence)).toBeTruthy();
});

const SHELL = join(import.meta.dirname, "..");
const COLOUR = [
  { name: "hex colour", re: /#[0-9a-fA-F]{3,8}\b/ },
  { name: "colour function", re: /\b(?:oklch|oklab|rgba?|hsla?|hwb|lab|lch)\(/ },
  {
    name: "palette class",
    re: /\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|shadow|divide|accent|caret|decoration|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)\b/,
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

test("no colour under shell/ except through design tokens", () => {
  const files = sourceFiles(SHELL);
  expect(files.length).toBeGreaterThan(0);
  const found: string[] = [];
  for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      for (const { name, re } of COLOUR) if (re.test(line)) found.push(`${relative(SHELL, file)}:${index + 1} ${name}: ${line.trim()}`);
    });
  }
  expect(found).toEqual([]);
});

test("the colour check catches each kind", () => {
  for (const [line, kind] of [
    [`className="text-red-500"`, 2],
    [`style={{ color: "#ff0000" }}`, 0],
    [`color: oklch(0.5 0.2 20)`, 1],
    [`"bg-white"`, 2],
  ] as const) {
    expect(COLOUR[kind].re.test(line), line).toBe(true);
  }
  expect(COLOUR.some(({ re }) => re.test(`"bg-destructive/10 text-muted-foreground border-border bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]"`))).toBe(false);
});

test("sentinel strings: every first-run screen uses no other wording", async () => {
  const strings = sentinel(defaultStrings);
  const config = { id: "test-app", name: "Test App", tables: {} };
  const data = [...DATA, FOLDER, PASSPORT_FILE, USER, DEVICE, "Test App", __APP_VERSION__, __BUILT_AT__, "Error: a written-for-users error", "a written-for-users error", "the app's screen"];
  const seen: string[] = [];
  const look = (label: string) => {
    seen.push(label);
    expect(strayWords(wording(), data), label).toEqual([]);
  };
  const said = () => new PassportError("other-workspace");
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  // starting, then failed (local storage unavailable)
  let fakes = fakeServices({ openDb: () => new Promise(() => undefined) });
  render(<TrellisApp config={config} services={fakes.services} strings={strings} />);
  look("starting");
  cleanup();
  fakes = fakeServices({ openDb: async () => Promise.reject(new Error("a written-for-users error")) });
  render(<TrellisApp config={config} services={fakes.services} strings={strings} />);
  await screen.findByRole("alert");
  look("failed");
  cleanup();

  // folder: none, then needs permission and refused
  fakes = fakeServices({ loadFolder: async () => ({ status: "none" }) });
  render(<TrellisApp config={config} services={fakes.services} strings={strings} />);
  await screen.findByRole("button");
  look("folder none");
  cleanup();
  const lapsed = { status: "needs-permission", handle: folderHandle } as const;
  fakes = fakeServices({ loadFolder: async () => lapsed, regrant: async () => lapsed });
  render(<TrellisApp config={config} services={fakes.services} strings={strings} />);
  fireEvent.click(await screen.findByRole("button"));
  await screen.findByRole("alert");
  look("folder refused");
  cleanup();

  // passport, invite form, invite refused, invite accepted, then running with the banner
  fakes = fakeServices({ folderPermission: async () => "prompt" });
  let enrolOk = false;
  const enrol = fakes.services.enrol;
  fakes.services.enrol = async (args) => (enrolOk ? enrol(args) : Promise.reject(Object.assign(said(), { message: "a written-for-users error" })));
  render(
    <TrellisApp config={config} services={fakes.services} strings={strings}>
      <p>the app's screen</p>
    </TrellisApp>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /haveInvite/ }));
  look("invite form");
  fireEvent.click(screen.getByRole("button", { name: /openInvite/ }));
  await screen.findByRole("alert");
  look("invite message");
  enrolOk = true;
  fireEvent.change(screen.getByLabelText(/inviteFile/), { target: { files: [new File(["x"], "x.json")] } });
  fireEvent.click(screen.getByRole("button", { name: /openInvite/ }));
  await screen.findByRole("button", { name: /savePassport/ });
  look("invite accepted");
  fireEvent.click(screen.getByRole("button", { name: /savePassport/ }));
  await screen.findByText("the app's screen");
  look("running");
  act(() => fakes.engines[0]!.setHealth({ state: "folder-disconnected" }));
  await screen.findByRole("region");
  look("running with the reconnect banner");
  cleanup();

  // passport chooser, unlock with a message, already open
  fakes = fakeServices({ startHost: async () => ({ ok: false, reason: "already-open" }) });
  const unlock = fakes.services.unlock;
  let unlockOk = false;
  fakes.services.unlock = async (args) => (unlockOk ? unlock(args) : Promise.reject(Object.assign(said(), { message: "a written-for-users error" })));
  render(<TrellisApp config={config} services={fakes.services} strings={strings} />);
  await screen.findByRole("button", { name: /havePassport/ });
  look("passport");
  fireEvent.click(screen.getByRole("button", { name: /havePassport/ }));
  await screen.findByRole("button", { name: /unlock/ });
  fireEvent.click(screen.getByRole("button", { name: /unlock/ }));
  await screen.findByRole("alert");
  look("unlock message");
  unlockOk = true;
  fireEvent.click(screen.getByRole("button", { name: /unlock/ }));
  await screen.findByRole("button", { name: /tryAgain/ });
  look("already open");

  expect(seen).toHaveLength(12);
});
