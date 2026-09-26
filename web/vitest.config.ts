import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // The app guards server modules with "server-only"; tests run in Node and stub it out.
      "server-only": path.resolve(__dirname, "src/test/server-only-stub.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: [
        "src/lib/**/*.test.ts",
        "src/lib/**/fixtures/**",
        "src/lib/**/__snapshots__/**",
        // Type-only module: no executable statements.
        "src/lib/search/types.ts",
      ],
      reporter: ["text-summary", "json-summary"],
      // Measured 2026-09-26: lines 75.45 %, statements 72.76 %, functions 73.17 %,
      // branches 64.21 %. Lines enforces the brief's 1.0 bar (70 %); the rest are
      // honest floors (floor(measured) - 2) to catch regressions — raise them as
      // lib/ tests land.
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 71,
        branches: 62,
      },
    },
  },
});
