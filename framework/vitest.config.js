// Component tests for the shell (spec S4): React Testing Library in jsdom.
// The engine and runtime keep their node --test suites; only .tsx tests run here.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  test: { environment: "jsdom", include: ["runtime/shell/test/**/*.test.tsx"] },
});
