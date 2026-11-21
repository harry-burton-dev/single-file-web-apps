import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const pkg = JSON.parse(readFileSync(here("./package.json"), "utf8")) as { version: string };

// Mint: one self-contained HTML file that runs when opened from disk (file://).
// The entry page lives in ../masters because the project's filing hook only
// accepts HTML documents there or in an epic folder.
export default defineConfig({
  root: here("../masters"),
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: { alias: { "@": here("./src"), "/@app": here("./src") } },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
  server: { fs: { allow: [here("..")] } },
  build: {
    target: "es2022",
    outDir: here("./dist"),
    emptyOutDir: true,
    rollupOptions: { input: here("../masters/workbench.html") },
  },
});
