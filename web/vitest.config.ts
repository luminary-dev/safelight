import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Vitest projects per TEST-BRIEF §4: unit, db, api, agent, subsystems (node)
 * and component (jsdom), each runnable alone (`vitest run --project api`).
 * The includes partition the old single glob (src/**\/*.test.ts) exactly —
 * every existing test keeps running, under the project that owns its tier.
 */

/** Directories owned by a non-unit project; the unit catch-all excludes them. */
const DB_TESTS = "src/lib/db/**/*.test.ts";
const AGENT_TESTS = "src/lib/agent/**/*.test.ts";
const API_TESTS = "src/app/**/*.test.ts";
const SUBSYSTEM_TESTS = [
  "src/lib/blueprints/**/*.test.ts",
  "src/lib/library/**/*.test.ts",
  "src/lib/models/**/*.test.ts",
  "src/lib/usage/**/*.test.ts",
  "src/lib/theme/**/*.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // The app guards server modules with "server-only"; tests run in Node and stub it out.
      "server-only": path.resolve(__dirname, "src/test/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["src/test/setup.matchers.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: [...configDefaults.exclude, DB_TESTS, AGENT_TESTS, API_TESTS, ...SUBSYSTEM_TESTS],
        },
      },
      { extends: true, test: { name: "db", include: [DB_TESTS] } },
      { extends: true, test: { name: "api", include: [API_TESTS] } },
      { extends: true, test: { name: "agent", include: [AGENT_TESTS] } },
      { extends: true, test: { name: "subsystems", include: SUBSYSTEM_TESTS } },
      {
        extends: true,
        test: {
          name: "component",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["src/test/setup.matchers.ts", "src/test/setup.component.ts"],
        },
      },
    ],
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
      // Measured 2026-09-26 (post TEST-BRIEF phases 0-6 + responsive tiers + license) over
      // the full surface: lines 78.65 %, statements 75.27 %, functions 66.04 %, branches 66.05 %.
      thresholds: {
        lines: 76,
        statements: 73,
        functions: 64,
        branches: 64,
      },
    },
  },
});
