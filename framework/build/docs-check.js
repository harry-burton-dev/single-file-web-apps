// Checks that keep the user docs honest. Run by framework/test/docs.test.js.
//
//   exports   every name the public entry exports has a heading in
//             docs/reference/api.md, and no heading names a non-export
//   links     every relative link and #anchor in the user docs resolves
//   samples   every ts/tsx sample typechecks against @trellis/framework and
//             imports only what app code may import (gate G5's rule)
//
// A sample is a fenced block whose language is ts or tsx. If its first line is
// a comment naming a file under app/ (`// app/src/screen.tsx`), it is that
// file; otherwise it is a module of its own. Each page is checked as a copy of
// docs/samples/app (the example app the docs describe) with the page's files
// laid over it, so a page that shows a new app/app.config.ts gets its own row
// types, and a project's own app can change without breaking the docs. A block
// marked `ts signature` (a declaration's shape) or `ts fragment` (part of a
// file) is not compiled.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { appPackages, findViolations } from "./boundary.js";

/** The user docs: what a created project keeps. Paths are relative to the repository. */
export const USER_DOCS = ["docs/README.md", "docs/quickstart.md", "docs/guides", "docs/reference", "docs/explanation"];
export const API_REFERENCE = "docs/reference/api.md";
const PUBLIC_ENTRY = "framework/index.ts";
const WORK_DIR = "dist/docs-check";
/** The app the samples are written against: the example app as the docs describe it, not the project's own app, which changes. */
const SAMPLE_APP = "docs/samples/app";
const NAMED_FILE = /^\/\/ (app\/[\w./-]+\.tsx?)\s*$/;

const posix = (path) => path.split(sep).join("/");

/** Every Markdown file of the user docs that exists, as repository-relative paths. */
export function docFiles(repo) {
  const found = [];
  const walk = (path) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) return readdirSync(path).sort().forEach((entry) => walk(join(path, entry)));
    if (path.endsWith(".md")) found.push(posix(relative(repo, path)));
  };
  USER_DOCS.forEach((entry) => walk(join(repo, entry)));
  return found;
}

/** The names a module re-exports with `export { a, type B } from` and `export type { C } from`. */
export function exportedNames(source) {
  const names = [];
  for (const [, list] of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
    for (const item of list.split(",")) {
      const name = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop();
      if (name) names.push(name);
    }
  }
  return names.sort();
}

/** The names the API reference documents: a heading that is one identifier in code font. */
export function documentedNames(markdown) {
  return [...withoutFences(markdown).matchAll(/^#{2,4} `([A-Za-z_$][\w$]*)`\s*$/gm)].map((m) => m[1]).sort();
}

/** Exports with no reference entry, and reference entries that name no export. */
export function exportCoverage(repo) {
  const exported = exportedNames(readFileSync(join(repo, PUBLIC_ENTRY), "utf8"));
  const documented = existsSync(join(repo, API_REFERENCE)) ? documentedNames(readFileSync(join(repo, API_REFERENCE), "utf8")) : [];
  return {
    exported,
    undocumented: exported.filter((name) => !documented.includes(name)),
    unknown: documented.filter((name) => !exported.includes(name)),
    duplicated: documented.filter((name, i) => documented.indexOf(name) !== i),
  };
}

/** The fenced blocks of a page: language, the rest of the info string, code, and the line the code starts on. */
export function fences(markdown) {
  const blocks = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)(`{3,})\s*(\S*)\s*(.*?)\s*$/);
    if (!open) continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && !new RegExp(`^\\s*${open[2]}\\s*$`).test(lines[end])) end++;
    blocks.push({ lang: open[3], info: open[4], code: lines.slice(start, end).join("\n"), line: start + 1 });
    i = end;
  }
  return blocks;
}

function withoutFences(markdown) {
  const lines = markdown.split("\n");
  for (const block of fences(markdown)) {
    for (let i = block.line - 2; i < block.line + block.code.split("\n").length; i++) lines[i] = "";
  }
  return lines.join("\n");
}

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens, repeats numbered. */
export function anchors(markdown) {
  const seen = new Map();
  return [...withoutFences(markdown).matchAll(/^#{1,6}\s+(.*?)\s*$/gm)].map(([, title]) => {
    const base = title.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  });
}

/** Relative links and anchors in the user docs that lead nowhere. */
export function brokenLinks(repo) {
  const broken = [];
  for (const file of docFiles(repo)) {
    const text = withoutFences(readFileSync(join(repo, file), "utf8")).replace(/`[^`\n]*`/g, "");
    for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [path, anchor] = target.split("#");
      const to = path === "" ? join(repo, file) : resolve(join(repo, dirname(file)), path);
      if (!existsSync(to)) broken.push(`${file}: ${target} (no such file)`);
      else if (anchor && statSync(to).isFile() && !anchors(readFileSync(to, "utf8")).includes(anchor)) broken.push(`${file}: ${target} (no such heading)`);
    }
  }
  return broken;
}

/** The ts and tsx samples of one page, each with the path it is written to inside the copy of the project. */
export function samplesOf(markdown) {
  let n = 0;
  return fences(markdown)
    .filter((block) => block.lang === "ts" || block.lang === "tsx")
    .map((block) => {
      const named = block.code.split("\n")[0].match(NAMED_FILE);
      const skipped = block.info.split(/\s+/).some((word) => word === "signature" || word === "fragment");
      const path = named ? named[1] : `app/src/sample-${++n}.${block.lang}`;
      return { ...block, path, skipped };
    });
}

function run(command, args, cwd) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => done({ status: 1, output: String(error) }));
    child.on("close", (status) => done({ status, output }));
  });
}

/**
 * Typechecks every sample and checks its imports. Returns the pages checked,
 * the count of compiled and skipped samples, and one entry per failing page.
 */
export async function checkSamples(repo) {
  const tsc = join(dirname(createRequire(join(repo, "package.json")).resolve("typescript/package.json")), "bin", "tsc");
  const work = join(repo, WORK_DIR);
  rmSync(work, { recursive: true, force: true });
  const appTsconfig = JSON.parse(readFileSync(join(repo, "app/tsconfig.json"), "utf8"));
  const allowedPackages = appPackages(join(repo, "app"));
  const pages = [];
  let compiled = 0;
  let skipped = 0;

  for (const file of docFiles(repo)) {
    const all = samplesOf(readFileSync(join(repo, file), "utf8"));
    const samples = all.filter((sample) => !sample.skipped);
    skipped += all.length - samples.length;
    if (samples.length === 0) continue;
    compiled += samples.length;
    const project = join(work, file.replace(/[^\w]+/g, "-"));
    const app = join(project, "app");
    mkdirSync(app, { recursive: true });
    cpSync(join(repo, SAMPLE_APP), app, { recursive: true });
    writeFileSync(join(app, "package.json"), readFileSync(join(repo, "app/package.json")));
    writeFileSync(join(app, "tsconfig.json"), JSON.stringify(appTsconfig));
    for (const sample of samples) {
      mkdirSync(dirname(join(project, sample.path)), { recursive: true });
      writeFileSync(join(project, sample.path), `${sample.code}\n`);
    }
    pages.push({ file, app, samples });
  }

  const failures = [];
  await Promise.all(
    pages.map(async ({ file, app, samples }) => {
      const where = samples.map((sample) => `  ${sample.path} is ${file}:${sample.line}`).join("\n");
      const imports = findViolations(app, { allowedPackages }).map((v) => `  ${v.file}:${v.line} imports "${v.specifier}": ${v.reason}`);
      if (imports.length) failures.push(`${file}: a sample imports what app code may not\n${imports.join("\n")}\n${where}`);
      const result = await run(process.execPath, [tsc, "--noEmit", "-p", app], repo);
      if (result.status !== 0) failures.push(`${file}: samples do not typecheck\n${result.output.trim()}\n${where}`);
    }),
  );
  return { pages: pages.map((page) => page.file), compiled, skipped, failures: failures.sort() };
}
