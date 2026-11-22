// The rubric (docs/framework/README.md section 3, spec S6 Deliver 2): runs the
// check for each gate G1 to G11, prints the table with pass or fail and the
// command that decided it, and exits 1 if any gate fails. G12 and G13 are not
// here: a fresh agent and GitHub's release run decide those.
//
// A gate whose check has not landed yet fails with "check not present". It is
// never skipped. When an epic lands a gate's check, it updates that gate's
// command and `present` below.
//
//   npm run rubric                      the real gates
//   node framework/build/rubric.js --gates <file.js>   another list (tests)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const gates = [
  { id: "G1", requirement: "New project: `create` makes a project that installs, typechecks, tests and builds", command: "node --test framework/build/test/create.test.js" },
  { id: "G2", requirement: "No leftover names in a created project outside the allowed list", command: "node --test framework/build/test/create-names.test.js" },
  { id: "G3", requirement: "One definition file: names follow app/app.config.ts", command: "node --test framework/runtime/test/naming.test.js framework/runtime/test/build-names.test.js" },
  { id: "G4", requirement: "No business logic in framework folders", command: "node --test framework/runtime/test/empty-app.test.js" },
  { id: "G5", requirement: "Screens import only the framework's public entry", command: "node --test framework/test/boundary.test.js" },
  // The fixed-key check reads dist/, so it needs a build first (`npm run ci` does one).
  { id: "G6", requirement: "Real keys: invited users read each other's data, an outsider cannot; no fixed key in the build", command: "node --test framework/runtime/test/identity/g6.test.js && npm run check:no-test-key" },
  { id: "G7", requirement: "Two users on one folder converge, from built files on disk", command: "npm run two-users" },
  {
    id: "G8",
    requirement: "Signed update end to end: N+1 offered and loaded, forged N+2 refused",
    command: "npm run smoke",
    // The smoke test exists but does not yet place a new release mid-session (OUT-28).
    present: () => readFileSync(join(ROOT, "framework/build/smoke.js"), "utf8").includes("checkForUpdate"),
  },
  // Step 6 of the smoke test is the from-disk backup and restore.
  { id: "G9", requirement: "Survives loss: backup and restore; newer schema refused", command: "node --test framework/runtime/test/backup/backup.test.js framework/data/test/migrations.test.js && npm run smoke" },
  { id: "G10", requirement: "Engine faults closed: all probes pass", command: "npm run probes" },
  // `npm run size` reads dist/, so it needs a build first (`npm run ci` does one).
  { id: "G11", requirement: "Size budgets: bootstrap under 50 KB, app bundle under 500 KB", command: "npm run size && node --test framework/test/size-budget.test.js" },
];

const TAIL_LINES = 30;

/** Runs each gate in `list` from `cwd`. Returns { rows, failed }. */
export function runGates(list, cwd = ROOT) {
  const rows = list.map((gate) => {
    if (gate.present && !gate.present()) return { gate, result: "fail: check not present", output: "" };
    const run = spawnSync(gate.command, { cwd, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? String(run.error) : ""}`;
    return { gate, result: run.status === 0 ? "pass" : "fail", output };
  });
  return { rows, failed: rows.filter((r) => r.result !== "pass").length };
}

export function formatTable(rows) {
  const cell = (s) => String(s).replaceAll("|", "\\|");
  return [
    "| Gate | Requirement | Result | Command |",
    "|---|---|---|---|",
    ...rows.map(({ gate, result }) => `| ${gate.id} | ${cell(gate.requirement)} | ${result} | \`${cell(gate.command)}\` |`),
  ].join("\n");
}

async function main(argv) {
  const i = argv.indexOf("--gates");
  const list = i >= 0 ? (await import(pathToFileURL(resolve(argv[i + 1])).href)).gates : gates;
  const { rows, failed } = runGates(list);
  for (const { gate, output } of rows.filter((r) => r.output && r.result !== "pass")) {
    console.log(`\n--- ${gate.id} failed: ${gate.command} (last ${TAIL_LINES} lines)`);
    console.log(output.trimEnd().split("\n").slice(-TAIL_LINES).join("\n"));
  }
  console.log(`\n${formatTable(rows)}\n\n${rows.length - failed} of ${rows.length} gates pass.`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
