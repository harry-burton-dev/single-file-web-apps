// `npm run create -- <name> [--dir <parent>]` (spec S6, Deliver 1; gate G1).
// Copies this repository's tracked files to <parent>/<name> (default: the
// folder beside this repository), gives the copy its own names and version
// 0.1.0, removes the framework-only docs, starts a fresh git repository, then
// proves the result with an install and the project's own `npm run ci`.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The same rule as the app id in framework/runtime/definition.ts (assertAppDefinition).
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The one line in a created project that names the framework it was made from (gate G2). */
export const ATTRIBUTION = "Made with the Trellis framework.";

// Framework-only material that a created project does not take, including
// this command and its tests: a project is made from the framework repository.
const LEFT_OUT = [
  /^docs\/framework\//,
  /^docs\/adr-[^/]*\.md$/,
  /^docs\/sync-engine-test-spec\.md$/,
  /^epics\//,
  /^framework\/build\/create\.js$/,
  /^framework\/build\/test\/create[^/]*\.test\.js$/,
  // Checks on the framework's own example app: app-size holds it to 150 lines
  // (spec S4), and empty-app (G4) refuses its table and field names in
  // framework source. A project's own app grows past the first and may well
  // use a field name such as "name" that the framework also quotes.
  /^framework\/test\/app-size\.test\.js$/,
  /^framework\/runtime\/test\/empty-app\.test\.js$/,
];

const titleCase = (id) => id.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

function run(step, command, args, options) {
  console.log(`\n> ${step}`);
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`create: step "${step}" failed (exit ${result.status ?? result.error})`);
}

function editJson(file, edit) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, `${JSON.stringify(edit(data), null, 2)}\n`);
}

/** Sets name and version 0.1.0, keeping name and version at the top of the file. */
const named = (name) => ({ name: _n, version: _v, ...rest }) => ({ name, version: "0.1.0", ...rest });

function replaceOnce(text, pattern, value, file) {
  if (!pattern.test(text)) throw new Error(`create: ${file} has no ${pattern} to set`);
  return text.replace(pattern, value);
}

/**
 * Creates the project and returns its folder. `check: false` stops after the
 * copy and renames (the tests use it); otherwise install and `npm run ci` run.
 */
export function createProject(name, { dir = dirname(ROOT), check = true, source = ROOT } = {}) {
  if (typeof name !== "string" || !ID.test(name)) {
    throw new Error(`create: name ${JSON.stringify(name)} must be lower-case letters, digits and single hyphens, such as demo-app`);
  }
  const target = resolve(dir, name);
  if (existsSync(target)) throw new Error(`create: ${target} already exists`);

  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: source, encoding: "utf8" });
  if (listed.status !== 0) throw new Error(`create: git ls-files failed in ${source}: ${listed.stderr}`);
  const files = listed.stdout.split("\0").filter((f) => f && !LEFT_OUT.some((re) => re.test(f)) && existsSync(join(source, f)));

  try {
    for (const file of files) {
      mkdirSync(dirname(join(target, file)), { recursive: true });
      copyFileSync(join(source, file), join(target, file));
    }
    const configFile = join(target, "app/app.config.ts");
    let config = readFileSync(configFile, "utf8");
    config = replaceOnce(config, /id: "[^"]*",/, `id: ${JSON.stringify(name)},`, "app/app.config.ts");
    config = replaceOnce(config, /name: "[^"]*",/, `name: ${JSON.stringify(titleCase(name))},`, "app/app.config.ts");
    writeFileSync(configFile, config);
    editJson(join(target, "package.json"), (pkg) => {
      const { create: _create, ...scripts } = pkg.scripts;
      return named(name)({ ...pkg, scripts });
    });
    editJson(join(target, "app/package.json"), named(`${name}-app`));
    const quickstart = existsSync(join(target, "docs/quickstart.md")) ? "Start with [docs/quickstart.md](docs/quickstart.md).\n\n" : "";
    writeFileSync(join(target, "README.md"), `# ${titleCase(name)}\n\n${quickstart}${ATTRIBUTION}\n`);
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }

  run("git init", "git", ["init", "--quiet"], { cwd: target });
  if (!check) return target;

  run("npm install", "npm", ["install", "--no-audit", "--no-fund"], { cwd: target });
  // The bootstrap build needs the admin's public key. Without one, this proof
  // run uses a throwaway key that is never written to the project.
  const env = { ...process.env };
  if (!env.TRELLIS_PUBLIC_KEY) {
    const keys = spawnSync(process.execPath, ["framework/build/keygen.js"], { cwd: target, encoding: "utf8" });
    env.TRELLIS_PUBLIC_KEY = keys.stdout.match(/^TRELLIS_PUBLIC_KEY=(.*)$/m)?.[1];
  }
  run("npm run ci", "npm", ["run", "ci"], { cwd: target, env });
  console.log(`\nnpm run ci passed in ${target}`);
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--dir");
  const dir = i >= 0 ? args.splice(i, 2)[1] : undefined;
  try {
    createProject(args[0], { dir });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
