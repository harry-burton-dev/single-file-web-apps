// Failed saves are retried with a doubling delay that never exceeds retryMaxMs.
// (The clock guard at the start of each tick also clamps retryAt, so the
// scheduled time is checked straight after the failing tick, not only the gaps.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./_harness.js";

const RETRY = { retryInitialMs: 1000, retryMaxMs: 4000 };
const STEP = 500;

test("the next retry is never scheduled more than retryMaxMs ahead, however many saves failed", async () => {
  const w = await makeWorld({ options: RETRY });
  const a = await w.device("harry-aaaaaaaa");
  const failures = [];
  a.on("error", (e) => {
    if (e.scope === "save") failures.push(e.at);
  });
  w.folder.failWrites((p) => p.startsWith("data/"));
  a.table("notes").getMap("m").set("x", 1);
  let longest = 0;
  for (let t = 0; t < 90000; t += STEP) {
    w.clock.advance(STEP);
    await a.tick();
    const { retryAt } = a.status();
    if (retryAt == null) continue;
    longest = Math.max(longest, retryAt - w.clock.now());
    assert.ok(retryAt - w.clock.now() <= RETRY.retryMaxMs, `retry scheduled ${retryAt - w.clock.now()} ms ahead after ${failures.length} failures`);
  }
  assert.ok(failures.length >= 10, `at least 10 saves failed (${failures.length})`);
  assert.ok(longest >= RETRY.retryMaxMs - STEP, "the delay did reach the cap");
  const gaps = failures.slice(1).map((t, i) => t - failures[i]);
  for (const gap of gaps) assert.ok(gap <= RETRY.retryMaxMs + STEP, `retry gap ${gap} ms exceeds retryMaxMs`);
  w.folder.clearFailures();
  await w.run([a], RETRY.retryMaxMs + 2000, STEP);
  assert.equal(a.status().pending, 0, "saved soon after the folder recovers");
});
