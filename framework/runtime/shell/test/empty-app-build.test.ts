// An app with no tables and no screens builds through the Vite factory, and the
// bundle shows the empty shell (spec S4, acceptance 4).
import { afterAll, expect, test } from "vitest";
import { build, type UserConfig } from "vite";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appConfig } from "../../../build/vite.config.js";

// Inside the repository (dist/ is ignored by git) so the test runner may import the bundle.
const outDir = join(import.meta.dirname, "..", "..", "..", "..", "dist", "empty-app-test");
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

test("builds with no tables and no screens, and shows the empty shell", async () => {
  const definition = { id: "empty", name: "Empty", tables: {} };
  const config = appConfig({ definition, version: "0.0.0", mode: "app", outDir }) as UserConfig & { build: NonNullable<UserConfig["build"]> };
  const input = join(import.meta.dirname, "fixtures", "empty-app", "main.tsx");
  // The test runner sets NODE_ENV=test; build as `npm run build` does.
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({ ...config, mode: "production", configFile: false, logLevel: "silent", build: { ...config.build, rollupOptions: { ...config.build.rollupOptions, input } } });
  } finally {
    process.env.NODE_ENV = nodeEnv;
  }

  const [file] = readdirSync(join(outDir, "app"));
  expect(file).toBe("empty-0.0.0.js");
  const { start } = await import(/* @vite-ignore */ join(outDir, "app", file));
  const element = document.createElement("div");
  document.body.append(element);
  start({ mount: element });

  const shell = await waitFor(() => element.querySelector("#app-shell"));
  expect(shell.getAttribute("aria-label")).toBe("Empty");
}, 60_000);

async function waitFor<T>(find: () => T | null): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const found = find();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("not found");
}
