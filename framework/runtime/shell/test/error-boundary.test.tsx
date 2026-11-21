// The error screen: shows the error and offers the diagnostics view.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { defaultStrings } from "../strings";
import { ShellProvider } from "../index";
import { fakeEngine } from "./helpers/fake-engine";

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Broken(): never {
  throw new TypeError("table went missing");
}

test("an error in the app's screens shows the error screen with the message", () => {
  render(
    <ShellProvider engine={fakeEngine()}>
      <Broken />
    </ShellProvider>,
  );
  const alert = screen.getByRole("alert");
  expect(within(alert).getByRole("heading", { name: defaultStrings.errorTitle })).toBeTruthy();
  expect(within(alert).getByText("TypeError: table went missing")).toBeTruthy();
});

test("the error screen opens the diagnostics view", () => {
  render(
    <ShellProvider engine={fakeEngine()}>
      <Broken />
    </ShellProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: defaultStrings.openDiagnostics }));
  expect(screen.getByRole("dialog", { name: defaultStrings.diagnostics })).toBeTruthy();
});

test("without an engine there is no diagnostics view to offer", () => {
  render(
    <ShellProvider>
      <Broken />
    </ShellProvider>,
  );
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("button", { name: defaultStrings.openDiagnostics })).toBeNull();
});
