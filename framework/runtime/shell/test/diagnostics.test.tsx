// The diagnostics view: today's sync inspector, behind the health menu.
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { defaultStrings } from "../strings";
import { HealthIndicator, ShellProvider } from "../index";
import { emptyMetrics, fakeEngine } from "./helpers/fake-engine";
import type { Trace } from "../../host/engine-types";

afterEach(cleanup);

const trace: Trace = {
  id: 7,
  kind: "save",
  startedAt: 0,
  durationMs: 12.4,
  outcome: "failed",
  reason: "quiet",
  counts: {},
  steps: [{ at: 0, table: null, path: "t/1.bin", action: "write", bytes: 40, durationMs: 3, result: "ok", error: "NotAllowedError" }],
};

function openDiagnostics() {
  fireEvent.click(screen.getByRole("button", { name: defaultStrings.health.saved.label }));
  fireEvent.click(screen.getByRole("menuitem", { name: defaultStrings.diagnostics }));
  return screen.getByRole("dialog", { name: defaultStrings.diagnostics });
}

test("lists metrics and sync attempts, and opens an attempt's file steps", () => {
  const metrics = { ...emptyMetrics, errors: { total: 2 } };
  render(
    <ShellProvider engine={fakeEngine({ traces: [trace], metrics })}>
      <HealthIndicator />
    </ShellProvider>,
  );
  const dialog = openDiagnostics();
  expect(within(dialog).getByText(defaultStrings.errors).nextElementSibling?.textContent).toBe("2");
  const attempt = within(dialog).getByRole("button", { name: /save/ });
  expect(attempt.getAttribute("aria-expanded")).toBe("false");
  expect(within(dialog).queryByText("t/1.bin")).toBeNull();
  fireEvent.click(attempt);
  expect(attempt.getAttribute("aria-expanded")).toBe("true");
  expect(within(dialog).getByText("t/1.bin")).toBeTruthy();
  expect(within(dialog).getByText("NotAllowedError")).toBeTruthy();
});

test("Escape on the dialog closes it", () => {
  render(
    <ShellProvider engine={fakeEngine()}>
      <HealthIndicator />
    </ShellProvider>,
  );
  const dialog = openDiagnostics();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});
