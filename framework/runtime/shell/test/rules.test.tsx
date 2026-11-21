// The two rules every shell piece follows (spec S4, Deliver 3 and "Defaults
// chosen" 2): every word comes from the strings file, and no colour is
// written except through the project's design tokens.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { defaultStrings, type ShellStringOverrides } from "../strings";
import { HealthIndicator, ShellProvider } from "../index";
import { clockTime } from "../format";
import { emptyMetrics, fakeEngine } from "./helpers/fake-engine";
import { HEALTH_STATES } from "../../../engine/src/engine/health.js";
import type { HealthState, Trace } from "../../host/engine-types";

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
