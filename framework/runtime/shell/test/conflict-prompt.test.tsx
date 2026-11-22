// The conflict prompt (spec S4, Deliver 2; ADR-0002 section 5): a count in the
// health area while any "ask" field is in conflict, opened by the person, never
// taking over the page. Component tests on a fake data runtime, then two real
// in-memory engines.
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Conflict } from "../../../data/conflicts";
import type { Data } from "../../../data/runtime";
import { DataProvider } from "../../../react/hooks";
import { makeDataWorld, notesApp } from "../../../data/test/_world.js";
import { ConflictPrompt } from "../conflict-prompt";
import { clockAndDate } from "../format";
import { ShellProvider } from "../provider";
import { defaultStrings as s } from "../strings";

afterEach(cleanup);

const conflict: Conflict = {
  table: "notes",
  id: "n1",
  field: "room",
  value: "Beta",
  candidates: [
    { value: "Alpha", user: "harry", device: "harry-aaaaaaaa", writtenAt: 10 },
    { value: "Beta", user: "sam", device: "sam-bbbbbbbb", writtenAt: 20 },
  ],
};

/** A data runtime with a settable conflict list; resolving clears it, as the real one does once the write lands. */
function fakeData(initial: readonly Conflict[]) {
  let list = initial;
  const listeners = new Set<() => void>();
  const set = (next: readonly Conflict[]) => {
    list = next;
    for (const listener of [...listeners]) listener();
  };
  const run = vi.fn((_name: unknown, _input: unknown) => {
    set([]);
    return { ok: true as const, value: undefined };
  });
  const data = {
    conflicts: {
      subscribe: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
      getSnapshot: () => list,
    },
    run,
  } as unknown as Data;
  return { data, run, set };
}

function renderPrompt(data: Data) {
  return render(
    <ShellProvider>
      <DataProvider data={data}>
        <ConflictPrompt />
        <p>the app's screen</p>
      </DataProvider>
    </ShellProvider>,
  );
}

test("no conflicts shows nothing", () => {
  const { container } = render(
    <ShellProvider>
      <DataProvider data={fakeData([]).data}>
        <ConflictPrompt />
      </DataProvider>
    </ShellProvider>,
  );
  expect(container.textContent).toBe("");
});

test("one conflict shows a count; opening it lists the record, the field and both candidates", () => {
  renderPrompt(fakeData([conflict]).data);
  const count = screen.getByRole("button", { name: s.needsDecision(1) });
  expect(count.getAttribute("aria-expanded")).toBe("false");
  // Not opened by itself, and the screen stays usable.
  expect(screen.queryByRole("region", { name: s.decisionsTitle })).toBeNull();
  expect(screen.getByText("the app's screen")).toBeTruthy();

  fireEvent.click(count);
  expect(count.getAttribute("aria-expanded")).toBe("true");
  const region = screen.getByRole("region", { name: s.decisionsTitle });
  const group = within(region).getByRole("group", { name: s.conflictAbout("notes", "n1", "room") });
  expect(within(group).getByRole("button", { name: s.keep("Alpha") })).toBeTruthy();
  expect(within(group).getByRole("button", { name: s.keep("Beta") })).toBeTruthy();
  expect(within(group).getByText(s.writtenBy("harry", clockAndDate(10)))).toBeTruthy();
  expect(within(group).getByText(s.writtenBy("sam", clockAndDate(20)))).toBeTruthy();
  // Who wrote it is the user, never the device id.
  expect(region.textContent).not.toContain("harry-aaaaaaaa");
  expect(screen.getByText("the app's screen")).toBeTruthy();
});

test("choosing a candidate resolves the conflict with that value, and the count clears", () => {
  const { data, run } = fakeData([conflict]);
  renderPrompt(data);
  fireEvent.click(screen.getByRole("button", { name: s.needsDecision(1) }));
  fireEvent.click(screen.getByRole("button", { name: s.keep("Alpha") }));
  expect(run).toHaveBeenCalledWith("records.resolve", { table: "notes", id: "n1", field: "room", value: "Alpha" });
  expect(screen.queryByRole("button", { name: s.needsDecision(1) })).toBeNull();
  expect(screen.queryByRole("region", { name: s.decisionsTitle })).toBeNull();
});

test("the count follows the list, and the prompt can be closed", () => {
  const { data, set } = fakeData([conflict]);
  renderPrompt(data);
  act(() => set([conflict, { ...conflict, id: "n2" }]));
  fireEvent.click(screen.getByRole("button", { name: s.needsDecision(2) }));
  expect(screen.getAllByRole("group")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: s.close }));
  expect(screen.queryByRole("region", { name: s.decisionsTitle })).toBeNull();
  expect(screen.getByRole("button", { name: s.needsDecision(2) })).toBeTruthy();
});

test("two engines: a concurrent ask edit shows the prompt on both; resolving on one clears both", async () => {
  const world = await makeDataWorld(notesApp);
  const a = await world.data("harry-aaaaaaaa");
  const b = await world.data("sam-bbbbbbbb");
  const sync = () => world.run([a.engine, b.engine], 30000);
  a.data.run("records.create", { table: "notes", id: "n1", fields: { room: "Start" } });
  await sync();

  const onA = within(renderPrompt(a.data).container);
  const onB = within(renderPrompt(b.data).container);
  for (const side of [onA, onB]) expect(side.queryByRole("button", { name: s.needsDecision(1) })).toBeNull();

  await act(async () => {
    world.clock.advance(10);
    a.data.run("records.update", { table: "notes", id: "n1", fields: { room: "Alpha" } });
    world.clock.advance(10);
    b.data.run("records.update", { table: "notes", id: "n1", fields: { room: "Beta" } });
    await sync();
  });
  for (const side of [onA, onB]) {
    fireEvent.click(side.getByRole("button", { name: s.needsDecision(1) }));
    const group = side.getByRole("group", { name: s.conflictAbout("notes", "n1", "room") });
    expect(within(group).getByRole("button", { name: s.keep("Alpha") })).toBeTruthy();
    expect(within(group).getByRole("button", { name: s.keep("Beta") })).toBeTruthy();
    const harry = a.data.conflicts.getSnapshot()[0]!.candidates.find((c) => c.user === "harry")!;
    expect(within(group).getByText(s.writtenBy("harry", clockAndDate(harry.writtenAt)))).toBeTruthy();
  }

  await act(async () => {
    fireEvent.click(onA.getByRole("button", { name: s.keep("Alpha") }));
    await sync();
  });
  for (const side of [onA, onB]) {
    expect(side.queryByRole("button", { name: s.needsDecision(1) })).toBeNull();
    expect(side.queryByRole("region", { name: s.decisionsTitle })).toBeNull();
  }
  expect(b.data.view("notes").rows().find((r) => r.id === "n1")?.room).toBe("Alpha");
});
