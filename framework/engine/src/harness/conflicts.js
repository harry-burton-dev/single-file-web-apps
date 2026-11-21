// P10, end to end through the engine: writes made to an "ask" field without
// knowledge of each other are all retrievable on every device until one write
// resolves them, and the resolution clears the conflict everywhere.
import { createScenario } from "./scenario.js";

const ID = "r1";

function readConflict(sc, dev) {
  const table = dev.session.tables[sc.tableNames[0]];
  const f = table.field(ID, "owner");
  return { value: f.value, values: (f.conflict ?? []).map((c) => c.value).sort(), listed: table.conflicts().filter((c) => c.id === ID && c.field === "owner").length };
}

export async function runConflictCheck({ variant = "baseline", seed = 1, faults = "none", optionOverrides } = {}) {
  const sc = await createScenario({ seed, variant, faults, devices: 3, tables: 1, optionOverrides });
  const fail = (message) => sc.violate("P10", { message });
  await sc.apply({ type: "edit", dev: 0, table: 0, op: "set", rec: ID, field: "title", value: "seed" });
  await sc.settle();
  for (let d = 0; d < 3; d++) await sc.apply({ type: "offline", dev: d });
  const written = ["A", "B", "C"];
  for (let d = 0; d < 3; d++) {
    await sc.apply({ type: "edit", dev: d, table: 0, op: "ask", rec: ID, value: written[d] });
    await sc.apply({ type: "advance", ms: 1500 });
  }
  for (let d = 0; d < 3; d++) await sc.apply({ type: "online", dev: d });
  await sc.settle();
  for (const dev of sc.devices) {
    const got = readConflict(sc, dev);
    if (JSON.stringify(got.values) !== JSON.stringify(written)) fail(`${dev.id} sees conflict candidates ${JSON.stringify(got.values)}, expected ${JSON.stringify(written)}`);
    if (got.listed !== 1) fail(`${dev.id} lists ${got.listed} open conflicts for the field, expected 1`);
  }
  await sc.apply({ type: "edit", dev: 1, table: 0, op: "resolve", pick: 0, value: "D" });
  await sc.settle();
  for (const dev of sc.devices) {
    const got = readConflict(sc, dev);
    if (got.values.length || got.listed || got.value !== "D") fail(`${dev.id} after resolution: value ${JSON.stringify(got.value)}, candidates ${JSON.stringify(got.values)}, open ${got.listed}; expected "D" and none`);
  }
  const result = await sc.finish({ newDevice: false });
  return result.violations;
}
