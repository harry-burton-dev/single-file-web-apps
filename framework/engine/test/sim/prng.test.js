import { test } from "node:test";
import assert from "node:assert/strict";
import { createRandom } from "../../src/sim/prng.js";
import { createClock, EPOCH_MS } from "../../src/sim/clock.js";

const take = (stream, n) => Array.from({ length: n }, () => stream.float());

test("same seed and stream name give the same sequence", () => {
  assert.deepEqual(take(createRandom("s").stream("x"), 20), take(createRandom("s").stream("x"), 20));
});

test("other streams do not disturb a stream", () => {
  const quiet = createRandom("s");
  const busy = createRandom("s");
  busy.stream("other").bytes(100);
  busy.stream("another").int(0, 9);
  assert.deepEqual(take(quiet.stream("x"), 10), take(busy.stream("x"), 10));
});

test("different names and seeds differ", () => {
  assert.notDeepEqual(take(createRandom("s").stream("x"), 5), take(createRandom("s").stream("y"), 5));
  assert.notDeepEqual(take(createRandom("s").stream("x"), 5), take(createRandom("t").stream("x"), 5));
  assert.notDeepEqual(take(createRandom(1).stream("x"), 5), take(createRandom(2).stream("x"), 5));
});

test("stream(name) returns the same continuing generator", () => {
  const random = createRandom("s");
  assert.notEqual(random.stream("x").float(), random.stream("x").float());
});

test("float is in [0,1) and int is inclusive", () => {
  const stream = createRandom("range").stream("x");
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const f = stream.float();
    assert.ok(f >= 0 && f < 1);
    seen.add(stream.int(3, 6));
  }
  assert.deepEqual([...seen].sort(), [3, 4, 5, 6]);
  assert.equal(stream.int(7, 7), 7);
  assert.throws(() => stream.int(5, 4), RangeError);
});

test("bytes returns n bytes and is deterministic", () => {
  const a = createRandom("b").stream("x").bytes(13);
  assert.ok(a instanceof Uint8Array);
  assert.equal(a.length, 13);
  assert.deepEqual(a, createRandom("b").stream("x").bytes(13));
  assert.equal(createRandom("b").stream("x").bytes(0).length, 0);
});

test("pick and chance", () => {
  const stream = createRandom("p").stream("x");
  const items = ["a", "b", "c"];
  for (let i = 0; i < 50; i++) assert.ok(items.includes(stream.pick(items)));
  assert.throws(() => stream.pick([]), RangeError);
  for (let i = 0; i < 50; i++) {
    assert.equal(stream.chance(0), false);
    assert.equal(stream.chance(1), true);
  }
});

test("clock starts at the fixed epoch and only moves when advanced", () => {
  const clock = createClock();
  assert.equal(clock.now(), EPOCH_MS);
  assert.equal(new Date(EPOCH_MS).toISOString(), "2026-01-05T09:00:00.000Z");
  clock.advance(1500);
  assert.equal(clock.now(), EPOCH_MS + 1500);
  assert.throws(() => clock.advance(-1), RangeError);
});
