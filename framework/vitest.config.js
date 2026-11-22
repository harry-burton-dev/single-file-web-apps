// Component tests for the shell (spec S4): React Testing Library in jsdom.
// The engine and runtime keep their node --test suites; only the shell and data-hook tests run here.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify("0.0.0-test"), __BUILT_AT__: JSON.stringify("2026-01-01T00:00:00.000Z") },
  test: { environment: "jsdom", include: ["runtime/shell/test/**/*.test.{ts,tsx}", "react/test/**/*.test.js"] },
});
