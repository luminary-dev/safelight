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
      // The FULL shipped surface — routes, components, middleware included. The old
      // lib/-only denominator hid ~half the code from the number that gates CI
      // (TEST-BRIEF §2).
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/fixtures/**",
        "src/**/__snapshots__/**",
        "src/test/**",
        // Type-only modules: no executable statements.
        "src/lib/search/types.ts",
        "src/lib/blueprints/types.ts",
        "src/lib/models/types.ts",
        "src/components/library/types.ts",
      ],
      reporter: ["text-summary", "json-summary"],
      // Thresholds are set from the measured baseline over the widened denominator
      // (floor(measured) - 2) and ratchet up, never down. TEST-BRIEF §20 has the
      // per-area targets this is climbing toward.
      // Measured 2026-09-26 over the full surface: lines 38.08 %, statements 36.71 %,
      // functions 26.77 %, branches 29.42 % (was 75.45 % lines over lib/ alone).
      thresholds: {
        lines: 36,
        statements: 34,
        functions: 24,
        branches: 27,
      },
    },
  },
});
