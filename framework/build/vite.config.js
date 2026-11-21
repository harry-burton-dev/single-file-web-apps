import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const pkg = JSON.parse(readFileSync(here("../../app/package.json"), "utf8"));
const PUBLIC_KEY_FILE = here("../../app/signing-public-key.json");

/** The admin's public key: WORKBENCH_PUBLIC_KEY (JWK as JSON), else signing-public-key.json. */
function signingPublicKey() {
  const text = process.env.WORKBENCH_PUBLIC_KEY ?? (existsSync(PUBLIC_KEY_FILE) ? readFileSync(PUBLIC_KEY_FILE, "utf8") : undefined);
  if (!text) throw new Error("The bootstrap needs the admin's public signing key: set WORKBENCH_PUBLIC_KEY or add app/signing-public-key.json.");
  return JSON.stringify(JSON.parse(text));
}

// Build targets (ADR-0005 section 1), chosen with --mode:
//   bootstrap  dist/workbench.html         one HTML file: the loader and the public signing key
//   app        dist/app/app-<version>.js   one ES module, styles included, run by the bootstrap
// `vite` (dev) serves masters/workbench-dev.html: the app directly, without the loader.
// The entry pages live in masters/ because the project's filing hook only
// accepts HTML documents there or in an epic folder.
export default defineConfig(({ mode }) => {
  const shared = {
    root: here("../../masters"),
    resolve: { alias: { "@": here("../../app/src"), "/@app": here("../../app/src"), "/@runtime": here("../runtime") } },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILT_AT__: JSON.stringify(new Date().toISOString()),
    },
    server: { fs: { allow: [here("../..")] }, open: "/workbench-dev.html" },
  };
  if (mode === "bootstrap") {
    return {
      ...shared,
      plugins: [viteSingleFile()],
      define: { ...shared.define, __SIGNING_PUBLIC_KEY__: signingPublicKey() },
      build: { target: "es2022", outDir: here("../../dist"), emptyOutDir: false, rollupOptions: { input: here("../../masters/workbench.html") } },
    };
  }
  if (mode === "app") {
    return {
      ...shared,
      plugins: [react(), tailwindcss()],
      define: { ...shared.define, "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        target: "es2022",
        outDir: here("../../dist/app"),
        emptyOutDir: true,
        // not Vite's library mode: that leaves ES modules unminified
        rollupOptions: {
          input: here("../../app/src/bundle.tsx"),
          preserveEntrySignatures: "exports-only",
          output: { format: "es", entryFileNames: `app-${pkg.version}.js`, codeSplitting: false },
        },
      },
    };
  }
  return { ...shared, plugins: [react(), tailwindcss()] };
});
