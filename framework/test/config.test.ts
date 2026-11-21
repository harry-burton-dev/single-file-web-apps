// validateConfig: the checks S1 puts on app.config.ts before anything starts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, type AppConfig } from "../config.ts";
import { engineTables } from "../runtime/tables.ts";

const base: AppConfig = { id: "example", name: "Example", tables: { scratch: { version: 1, fields: {} } } };
const withTables = (tables: AppConfig["tables"]): AppConfig => ({ ...base, tables });

test("a valid config is returned unchanged", () => {
  assert.equal(validateConfig(base), base);
  assert.doesNotThrow(() => validateConfig(withTables({})));
  assert.doesNotThrow(() => validateConfig({ ...base, id: "a" + "b".repeat(31) }));
});

test("the id must be a short lower-case picker id", () => {
  for (const id of ["", "Example", "1app", "-app", "app_1", "a".repeat(33)]) {
    assert.throws(() => validateConfig({ ...base, id }), /id/, id);
  }
});

test("the name must not be empty", () => {
  assert.throws(() => validateConfig({ ...base, name: "" }), /name/);
  assert.throws(() => validateConfig({ ...base, name: "   " }), /name/);
});

test("table names follow the engine's name rule", () => {
  for (const name of ["-x", "a_b", "a.b", ""]) {
    assert.throws(() => validateConfig(withTables({ [name]: { version: 1, fields: {} } })), /Table name/, name);
  }
});

test("reserved and malformed field names are refused", () => {
  for (const field of ["deleted", "id", "_hidden", "a\u001fb"]) {
    assert.throws(() => validateConfig(withTables({ t: { version: 1, fields: { [field]: { kind: "latest", type: "string" } } } })), /field/, field);
  }
  assert.doesNotThrow(() => validateConfig(withTables({ t: { version: 1, fields: { title: { kind: "latest", type: "string" }, body: { kind: "text" } } } })));
});

test("engineTables gives every configured table the yjs adapter", () => {
  assert.deepEqual(engineTables(base), { scratch: "yjs" });
  assert.deepEqual(engineTables(withTables({})), {});
});
