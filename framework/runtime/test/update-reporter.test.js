// Who tells the user about an update check (ADR-0005 section 6): the running
// app once it has subscribed through onUpdate, otherwise the bootstrap's own
// note, so an app that fails before it mounts is still covered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { updateReporter } from "../loader/updates.js";

const ready = { status: "updated", version: "1.1.0" };
const refused = { status: "rejected", code: "signature-invalid", message: "The release manifest is not signed by this app's admin. It was ignored." };

function world() {
  const drawn = [];
  let cleared = 0;
  const reporter = updateReporter({ draw: (result) => drawn.push(result), clear: () => void cleared++ });
  return { reporter, drawn, cleared: () => cleared };
}

test("no subscriber: the bootstrap draws its own note for each result", () => {
  const { reporter, drawn } = world();
  reporter.report(ready);
  reporter.report(refused);
  assert.deepEqual(drawn, [ready, refused]);
});

test("a subscriber gets each result and the bootstrap draws nothing", () => {
  const { reporter, drawn } = world();
  const heard = [];
  reporter.subscribe((result) => heard.push(result));
  reporter.report({ status: "current", version: "1.0.0" });
  reporter.report(ready);
  reporter.report(refused);
  assert.deepEqual(heard, [{ status: "current", version: "1.0.0" }, ready, refused]);
  assert.deepEqual(drawn, []);
});

test("a late subscriber hears the last result and the bootstrap's note is taken down", () => {
  const { reporter, drawn, cleared } = world();
  reporter.report(ready);
  assert.deepEqual(drawn, [ready]);
  const heard = [];
  reporter.subscribe((result) => heard.push(result));
  assert.deepEqual(heard, [ready]);
  assert.equal(cleared(), 1);
});

test("after unsubscribing, the bootstrap draws its note again", () => {
  const { reporter, drawn } = world();
  const heard = [];
  const unsubscribe = reporter.subscribe((result) => heard.push(result));
  unsubscribe();
  reporter.report(refused);
  assert.deepEqual(heard, []);
  assert.deepEqual(drawn, [refused]);
});
