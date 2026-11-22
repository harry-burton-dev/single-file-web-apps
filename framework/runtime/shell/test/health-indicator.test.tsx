// The health indicator in each of the engine's six states, its menu, and the
// diagnostics view it opens (spec S4, Deliver 2).
import { afterEach, describe, expect, test } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HEALTH_STATES } from "../../../engine/src/engine/health.js";
import { defaultStrings } from "../strings";
import { HealthIndicator, ShellProvider, useHealth } from "../index";
import { fakeEngine } from "./helpers/fake-engine";
import type { HealthState } from "../../host/engine-types";

afterEach(cleanup);

const PROBLEMS: HealthState[] = ["retrying", "folder-disconnected", "not-reaching-peers", "offline"];

describe("health indicator", () => {
  test("covers exactly the engine's six states", () => {
    expect(Object.keys(defaultStrings.health).sort()).toEqual([...HEALTH_STATES].sort());
  });

  test.each([...HEALTH_STATES] as HealthState[])("state %s: label and one plain sentence", (state) => {
    render(
      <ShellProvider engine={fakeEngine({ state })}>
        <HealthIndicator />
      </ShellProvider>,
    );
    const { label, sentence } = defaultStrings.health[state];
    const trigger = screen.getByRole("button", { name: label });
    expect(trigger).toHaveProperty("ariaHasPopup", "menu");
    expect(screen.getByText(sentence)).toBeTruthy();
    expect(trigger.getAttribute("aria-describedby")).toBe(screen.getByText(sentence).id);
    expect(trigger.querySelector("[data-slot=badge]")?.getAttribute("data-variant")).toBe(PROBLEMS.includes(state) ? "destructive" : "secondary");
  });

  test("follows health events from the engine", () => {
    const engine = fakeEngine({ state: "saving" });
    render(
      <ShellProvider engine={engine}>
        <HealthIndicator />
      </ShellProvider>,
    );
    act(() => engine.setHealth({ state: "folder-disconnected" }));
    expect(screen.getByRole("button", { name: defaultStrings.health["folder-disconnected"].label })).toBeTruthy();
  });

  test("shows pending changes, last save and folder read, and colleagues heard", () => {
    const engine = fakeEngine({ state: "saving", extra: { pending: 3, peers: { d1: { user: "sam", lastHeardAt: null, lastAckedAt: null, active: true, ackedLatest: false, waitingSince: null } } } });
    render(
      <ShellProvider engine={engine}>
        <HealthIndicator />
      </ShellProvider>,
    );
    expect(screen.getByText(defaultStrings.waiting(3))).toBeTruthy();
    expect(screen.getByText(defaultStrings.lastSave(defaultStrings.never))).toBeTruthy();
    expect(screen.getByText(defaultStrings.lastFolderRead(defaultStrings.never))).toBeTruthy();
    expect(screen.getByText(defaultStrings.peerHeard("sam", defaultStrings.never))).toBeTruthy();
  });

  test("shows Starting when there is no engine yet", () => {
    render(
      <ShellProvider>
        <HealthIndicator />
      </ShellProvider>,
    );
    expect(screen.getByRole("button", { name: defaultStrings.starting })).toBeTruthy();
  });
});

describe("health menu", () => {
  const setup = () => {
    const engine = fakeEngine({ state: "saved" });
    render(
      <ShellProvider engine={engine}>
        <HealthIndicator />
      </ShellProvider>,
    );
    return { engine, trigger: screen.getByRole("button", { name: defaultStrings.health.saved.label }) };
  };

  test("is closed until the indicator is pressed, then has one item: Diagnostics", () => {
    const { trigger } = setup();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: defaultStrings.healthMenu });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([defaultStrings.diagnostics]);
    expect(document.activeElement).toBe(items[0]);
  });

  test("Escape closes the menu and returns focus to the indicator", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("Diagnostics opens the diagnostics view, which is not on the page before", () => {
    const { engine, trigger } = setup();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: defaultStrings.diagnostics }));
    expect(screen.queryByRole("menu")).toBeNull();
    const dialog = screen.getByRole("dialog", { name: defaultStrings.diagnostics });
    fireEvent.click(within(dialog).getByRole("button", { name: defaultStrings.saveNow }));
    fireEvent.click(within(dialog).getByRole("button", { name: defaultStrings.readFolderNow }));
    expect(engine.calls).toEqual(["flush", "scan"]);
    expect(within(dialog).getByText(defaultStrings.noSyncAttempts)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: defaultStrings.close }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("useHealth", () => {
  function Probe() {
    const health = useHealth();
    return <p>{health ? health.state : "none"}</p>;
  }

  test("returns the engine's health and follows it", () => {
    const engine = fakeEngine({ state: "offline" });
    render(
      <ShellProvider engine={engine}>
        <Probe />
      </ShellProvider>,
    );
    expect(screen.getByText("offline")).toBeTruthy();
    act(() => engine.setHealth({ state: "saved" }));
    expect(screen.getByText("saved")).toBeTruthy();
  });

  test("returns null without an engine", () => {
    render(
      <ShellProvider>
        <Probe />
      </ShellProvider>,
    );
    expect(screen.getByText("none")).toBeTruthy();
  });
});
