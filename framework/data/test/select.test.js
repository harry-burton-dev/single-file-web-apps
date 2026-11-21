// where and sort (spec S2, Deliver 3), on plain arrays.
import { test } from "node:test";
import assert from "node:assert/strict";
import { select, stable } from "../select.ts";

const row = (id, fields, deleted = false) => ({ id, _deleted: deleted, _conflicts: {}, ...fields });
const rows = [
  row("a", { title: "Hi", n: 3, tag: { k: 1 } }),
  row("b", { title: "Yo", n: 1 }),
  row("c", { title: "Hi", n: 2 }, true),
  row("d", { title: "Hi" }),
  row("e", { title: "Zz", n: 2 }),
];
const ids = (list) => list.map((r) => r.id);

test("no query returns live rows in input order", () => {
  assert.deepEqual(ids(select(rows)), ["a", "b", "d", "e"]);
});

test("deleted rows are excluded by default", () => {
  assert.deepEqual(ids(select(rows, { where: { title: "Hi" } })), ["a", "d"]);
  assert.deepEqual(ids(select(rows, { where: { title: "Hi" }, includeDeleted: true })), ["a", "c", "d"]);
});

test("where object matches every given field, by value", () => {
  assert.deepEqual(ids(select(rows, { where: { title: "Hi", n: 3 } })), ["a"]);
  assert.deepEqual(ids(select(rows, { where: { tag: { k: 1 } } })), ["a"]);
  assert.deepEqual(ids(select(rows, { where: { title: "none" } })), []);
  assert.deepEqual(ids(select(rows, { where: {} })), ["a", "b", "d", "e"]);
});

test("where function filters", () => {
  assert.deepEqual(ids(select(rows, { where: (r) => (r.n ?? 0) >= 2 })), ["a", "e"]);
});

test("sort by key, ascending, missing values last, ties in input order", () => {
  assert.deepEqual(ids(select(rows, { sort: "n" })), ["b", "e", "a", "d"]);
  assert.deepEqual(ids(select(rows, { sort: "title" })), ["a", "d", "b", "e"]);
});

test("sort direction", () => {
  assert.deepEqual(ids(select(rows, { sort: { by: "n", dir: "desc" } })), ["a", "e", "b", "d"]);
  assert.deepEqual(ids(select(rows, { sort: { by: "n" } })), ["b", "e", "a", "d"]);
});

test("sort comparator", () => {
  assert.deepEqual(ids(select(rows, { sort: (x, y) => (x.id < y.id ? 1 : -1) })), ["e", "d", "b", "a"]);
});

test("select never changes its input", () => {
  const copy = [...rows];
  select(rows, { sort: { by: "n", dir: "desc" } });
  assert.deepEqual(rows, copy);
});

test("stable keeps the previous result when the elements are the same", () => {
  const first = select(rows, { where: { title: "Hi" } });
  const again = select(rows, { where: { title: "Hi" } });
  assert.notEqual(again, first);
  assert.equal(stable(first, again), first);
  assert.equal(stable(undefined, again), again);
  const other = select(rows, { where: { title: "Yo" } });
  assert.equal(stable(first, other), other);
  assert.equal(stable(first, [...first].reverse()).length, 2);
  assert.notEqual(stable(first, [...first].reverse()), first, "order matters");
  const obj = {};
  assert.equal(stable(obj, obj), obj);
  assert.equal(stable(1, 1), 1);
});
