// The update notice (spec S4, Deliver 2): the shell shows each update check's
// result through the loader's onUpdate, in the app's design and wording.
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { defaultStrings } from "../strings";
import { ShellProvider } from "../index";
import { UpdateNotice } from "../update-notice";
import type { UpdateResult } from "../../loader/contract";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A stand-in for the loader's onUpdate: push() delivers a result to whoever is subscribed. */
function fakeOnUpdate() {
  const listeners = new Set<(result: UpdateResult) => void>();
  const onUpdate = vi.fn((listener: (result: UpdateResult) => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  });
  const push = (result: UpdateResult) => act(() => listeners.forEach((listener) => listener(result)));
  return { onUpdate, push, listeners };
}

const refusal = "The release manifest is not signed by this app's admin. It was ignored.";

test("nothing shows until a check finds something, and a current version stays quiet", () => {
  const { onUpdate, push } = fakeOnUpdate();
  render(<ShellProvider><UpdateNotice onUpdate={onUpdate} /></ShellProvider>);
  expect(screen.queryByRole("status")).toBeNull();
  push({ status: "current", version: "1.0.0" });
  expect(screen.queryByRole("status")).toBeNull();
});

test("ready: names the version and Load it reloads the page", () => {
  const { onUpdate, push } = fakeOnUpdate();
  const reload = vi.fn();
  render(<ShellProvider><UpdateNotice onUpdate={onUpdate} reload={reload} /></ShellProvider>);
  push({ status: "updated", version: "1.1.0" });
  expect(screen.getByRole("status").textContent).toContain(defaultStrings.updateReady("1.1.0"));
  fireEvent.click(screen.getByRole("button", { name: defaultStrings.loadUpdate }));
  expect(reload).toHaveBeenCalledOnce();
});

test("refused: shows the loader's reason, with no button", () => {
  const { onUpdate, push } = fakeOnUpdate();
  render(<ShellProvider><UpdateNotice onUpdate={onUpdate} /></ShellProvider>);
  push({ status: "rejected", code: "signature-invalid", message: refusal });
  const status = screen.getByRole("status");
  expect(status.textContent).toContain(defaultStrings.updateRefused(refusal));
  expect(status.textContent).toContain("not signed");
  expect(screen.queryByRole("button")).toBeNull();
});

test("the provider shows the notice when given onUpdate, and unsubscribes on unmount", () => {
  const { onUpdate, push, listeners } = fakeOnUpdate();
  const { unmount } = render(<ShellProvider onUpdate={onUpdate} />);
  push({ status: "updated", version: "2.0.0" });
  expect(screen.getByRole("status").textContent).toContain(defaultStrings.updateReady("2.0.0"));
  unmount();
  expect(listeners.size).toBe(0);
});

test("the wording comes from the strings the app passes", () => {
  const { onUpdate, push } = fakeOnUpdate();
  render(<ShellProvider onUpdate={onUpdate} strings={{ updateReady: (v) => `Nieuwe versie ${v}`, loadUpdate: "Laden" }} />);
  push({ status: "updated", version: "3.0.0" });
  expect(screen.getByRole("status").textContent).toContain("Nieuwe versie 3.0.0");
  expect(screen.getByRole("button", { name: "Laden" })).toBeTruthy();
});
