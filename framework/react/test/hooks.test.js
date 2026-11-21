// The React data hooks (spec S2, acceptance bullet 1): each hook's rendered result,
// that each re-renders only when its own result changes, and the mounted
// two-engine cases (acceptance bullets 2 and 3 through a screen). Runs in jsdom
// under vitest. Plain .js like the data tests, so the app's Register types stay out.
import { afterEach, describe, expect, test } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { createCommandRegistry } from "../../data/commands.ts";
import { makeDataWorld, notesApp } from "../../data/test/_world.js";
import { DataProvider, resolveConflict, useCommand, useConflicts, useField, useRecord, useRecords, useResolveConflict } from "../hooks.ts";

afterEach(cleanup);

async function pair(commands) {
  const world = await makeDataWorld(notesApp);
  const a = await world.data("harry-aaaaaaaa", commands);
  const b = await world.data("sam-bbbbbbbb", commands);
  const sync = () => world.run([a.engine, b.engine], 30000);
  return { world, a: a.data, b: b.data, sync };
}

/** Mounts `use` on a provider for `data`; `latest()` is the last rendered result, `renders()` the render count. */
function mount(data, use) {
  const seen = { count: 0 };
  function Probe() {
    seen.value = use();
    seen.count++;
    return null;
  }
  render(createElement(DataProvider, { data }, createElement(Probe)));
  return { latest: () => seen.value, renders: () => seen.count };
}

const ids = (rows) => rows.map((r) => r.id);

describe("useRecords", () => {
  test("lists live rows with where and sort, and follows commands", async () => {
    const { a } = await pair();
    a.run("records.create", { table: "notes", id: "n1", fields: { title: "b", room: "x" } });
    a.run("records.create", { table: "notes", id: "n2", fields: { title: "a", room: "x" } });
    a.run("records.create", { table: "notes", id: "n3", fields: { title: "c", room: "y" } });
    const all = mount(a, () => useRecords("notes"));
    const inX = mount(a, () => useRecords("notes", { where: { room: "x" }, sort: "title" }));
    expect(ids(all.latest())).toEqual(["n1", "n2", "n3"]);
    expect(ids(inX.latest())).toEqual(["n2", "n1"]);
    act(() => void a.run("records.remove", { table: "notes", id: "n2" }));
    expect(ids(all.latest())).toEqual(["n1", "n3"]);
    expect(ids(inX.latest())).toEqual(["n1"]);
  });

  test("does not re-render when a record outside its where changes", async () => {
    const { a } = await pair();
    a.run("records.create", { table: "notes", id: "n1", fields: { room: "x" } });
    a.run("records.create", { table: "notes", id: "n2", fields: { room: "y" } });
    const inX = mount(a, () => useRecords("notes", { where: { room: "x" } }));
    const before = inX.renders();
    const first = inX.latest();
    act(() => void a.run("records.update", { table: "notes", id: "n2", fields: { title: "changed" } }));
    expect(inX.renders()).toBe(before);
    expect(inX.latest()).toBe(first);
    act(() => void a.run("records.update", { table: "notes", id: "n1", fields: { title: "changed" } }));
    expect(inX.renders()).toBe(before + 1);
  });

  test("a function where, a fresh inline query each render, still keeps its result", async () => {
    const { a } = await pair();
    a.run("records.create", { table: "notes", id: "n1", fields: { title: "keep" } });
    a.run("records.create", { table: "notes", id: "n2", fields: { title: "other" } });
    const kept = mount(a, () => useRecords("notes", { where: (r) => r.title === "keep" }));
    const before = kept.renders();
    act(() => void a.run("records.update", { table: "notes", id: "n2", fields: { title: "still other" } }));
    expect(kept.renders()).toBe(before);
    expect(ids(kept.latest())).toEqual(["n1"]);
  });
});

describe("useRecord", () => {
  test("returns the row, follows its changes, and is undefined for a missing id", async () => {
    const { a } = await pair();
    a.run("records.create", { table: "notes", id: "n1", fields: { title: "Hi" } });
    const one = mount(a, () => useRecord("notes", "n1"));
    const missing = mount(a, () => useRecord("notes", "nope"));
    expect(one.latest()?.title).toBe("Hi");
    expect(missing.latest()).toBeUndefined();
    act(() => void a.run("records.update", { table: "notes", id: "n1", fields: { title: "Hello" } }));
    expect(one.latest()?.title).toBe("Hello");
    act(() => void a.run("records.remove", { table: "notes", id: "n1" }));
    expect(one.latest()?._deleted).toBe(true);
  });

  test("does not re-render for another id", async () => {
    const { a } = await pair();
    a.run("records.create", { table: "notes", id: "n1", fields: { title: "Hi" } });
    a.run("records.create", { table: "notes", id: "n2", fields: { title: "Hi" } });
    const one = mount(a, () => useRecord("notes", "n1"));
    const before = one.renders();
    act(() => void a.run("records.update", { table: "notes", id: "n2", fields: { title: "Other" } }));
    act(() => void a.run("records.create", { table: "notes", id: "n3", fields: {} }));
    expect(one.renders()).toBe(before);
  });
});

describe("useField", () => {
  test("gives the value and no conflict, and follows changes", async () => {
    const { a } = await pair();
    a.run("records.create", { table: "notes", id: "n1", fields: { title: "Hi", room: "x" } });
    const title = mount(a, () => useField("notes", "n1", "title"));
    const room = mount(a, () => useField("notes", "n1", "room"));
    expect(title.latest()).toEqual({ value: "Hi", conflict: null });
    expect(room.latest()).toEqual({ value: "x", conflict: null });
    act(() => void a.run("records.update", { table: "notes", id: "n1", fields: { title: "Hello" } }));
    expect(title.latest()).toEqual({ value: "Hello", conflict: null });
    const missing = mount(a, () => useField("notes", "nope", "title"));
    expect(missing.latest()).toEqual({ value: undefined, conflict: null });
  });

  test("does not re-render when a different field changes", async () => {
    const { a } = await pair();
    a.run("records.create", { table: "notes", id: "n1", fields: { title: "Hi", room: "x" } });
    const room = mount(a, () => useField("notes", "n1", "room"));
    const before = room.renders();
    const first = room.latest();
    act(() => void a.run("records.update", { table: "notes", id: "n1", fields: { title: "Hello" } }));
    expect(room.renders()).toBe(before);
    expect(room.latest()).toBe(first);
  });
});

describe("useCommand", () => {
  test("runs built-ins by name and returns their result", async () => {
    const { a } = await pair();
    const create = mount(a, () => useCommand("records.create"));
    let result;
    act(() => { result = create.latest()({ table: "notes", id: "n1", fields: { title: "Hi" } }); });
    expect(result).toMatchObject({ ok: true, value: "n1" });
    expect(a.view("notes").byId("n1")?.title).toBe("Hi");
    const update = mount(a, () => useCommand("records.update"));
    let failed;
    act(() => { failed = update.latest()({ table: "notes", id: "nope", fields: { title: "x" } }); });
    expect(failed).toMatchObject({ ok: false, code: "failed" });
  });

  test("runs an app command and keeps the same function across renders", async () => {
    const commands = createCommandRegistry();
    const rename = commands.define("notes.rename", (tx, { id, title }) => tx.put("notes", id, { title }));
    const { a } = await pair(commands);
    a.run("records.create", { table: "notes", id: "n1", fields: { title: "Hi" } });
    const fns = new Set();
    const both = mount(a, () => {
      const run = useCommand(rename);
      fns.add(run);
      return { run, title: useField("notes", "n1", "title").value };
    });
    act(() => void both.latest().run({ id: "n1", title: "Renamed" }));
    expect(both.latest().title).toBe("Renamed");
    expect(both.renders()).toBe(2);
    expect(fns.size).toBe(1);
  });
});

describe("outside a DataProvider", () => {
  test("a hook throws a plain message", () => {
    function Probe() {
      useRecords("notes");
      return null;
    }
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(() => render(createElement(Probe))).toThrow(/DataProvider/);
    } finally {
      console.error = quiet;
    }
  });
});

describe("two engines, mounted", () => {
  test("a command on one engine appears in the other's useRecords result", async () => {
    const { a, b, sync } = await pair();
    const onB = mount(b, () => useRecords("notes", { where: { title: "Hi" } }));
    expect(onB.latest()).toEqual([]);
    await act(async () => {
      a.run("records.create", { table: "notes", id: "n1", fields: { title: "Hi" } });
      await sync();
    });
    expect(ids(onB.latest())).toEqual(["n1"]);
  });

  test("a concurrent ask edit is in useConflicts on both; resolving on one clears both", async () => {
    const { world, a, b, sync } = await pair();
    a.run("records.create", { table: "notes", id: "n1", fields: { room: "Start" } });
    await sync();
    const onA = mount(a, () => ({ list: useConflicts(), resolve: useResolveConflict(), room: useField("notes", "n1", "room") }));
    const onB = mount(b, () => ({ list: useConflicts(), room: useField("notes", "n1", "room") }));
    expect(onA.latest().list).toEqual([]);

    await act(async () => {
      world.clock.advance(10);
      a.run("records.update", { table: "notes", id: "n1", fields: { room: "Alpha" } });
      world.clock.advance(10);
      b.run("records.update", { table: "notes", id: "n1", fields: { room: "Beta" } });
      await sync();
    });
    for (const side of [onA, onB]) {
      const [c, ...rest] = side.latest().list;
      expect(rest).toEqual([]);
      expect(c).toMatchObject({ table: "notes", id: "n1", field: "room", value: "Beta" });
      expect(c.candidates.map((x) => x.value).sort()).toEqual(["Alpha", "Beta"]);
      expect(side.latest().room.value).toBe("Beta");
      expect(side.latest().room.conflict?.map((x) => x.value).sort()).toEqual(["Alpha", "Beta"]);
    }

    let resolved;
    await act(async () => {
      resolved = onA.latest().resolve(onA.latest().list[0], "Alpha");
      await sync();
    });
    expect(resolved?.ok).toBe(true);
    for (const side of [onA, onB]) {
      expect(side.latest().list).toEqual([]);
      expect(side.latest().room).toEqual({ value: "Alpha", conflict: null });
    }
  });

  test("resolveConflict works on the data object without a component", async () => {
    const { world, a, b, sync } = await pair();
    a.run("records.create", { table: "notes", id: "n1", fields: {} });
    await sync();
    world.clock.advance(10);
    a.run("records.update", { table: "notes", id: "n1", fields: { room: "Alpha" } });
    world.clock.advance(10);
    b.run("records.update", { table: "notes", id: "n1", fields: { room: "Beta" } });
    await sync();
    expect(b.conflicts.getSnapshot()).toHaveLength(1);
    expect(resolveConflict(b, { table: "notes", id: "n1", field: "room" }, "Beta").ok).toBe(true);
    await sync();
    expect(a.conflicts.getSnapshot()).toEqual([]);
    expect(b.conflicts.getSnapshot()).toEqual([]);
  });
});
