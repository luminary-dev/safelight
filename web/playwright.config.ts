import { defineConfig, devices } from "@playwright/test";

// True only when this invocation explicitly asked for the audit project
// (`playwright test --project audit` / `--project=audit`). Workers re-evaluate
// this config with their own argv, so the runner's main process records the
// answer in an env var that workers inherit; the audit spec reads the env var
// and skips itself otherwise, keeping the sweep out of a bare `playwright
// test` run. (Setting SAFELIGHT_AUDIT=1 by hand is an intentional escape
// hatch, e.g. for `--ui` where argv sniffing cannot see the project choice.)
const auditRequested = process.argv.some((arg, i, argv) => arg === "--project=audit" || (arg === "--project" && argv[i + 1] === "audit"));
if (auditRequested) process.env.SAFELIGHT_AUDIT = "1";

/**
 * Shell-level e2e: `e2e/dev-server.mjs` boots a dedicated dev server on port
 * 3005 against a fresh throwaway data root, with ComfyUI and Ollama pointed at
 * an unreachable port on purpose. The suite must never talk to the real dev
 * server (:3001), the real ComfyUI (:8188), a real Ollama, or the repo's real
 * data/ and outputs/ folders — the launcher owns that isolation.
 */
export default defineConfig({
  globalSetup: "./e2e/global-setup.mjs",
  testDir: "./e2e",
  // Part of the audit project wiring below: keeps e2e/audit out of the default
  // chromium suite (the audit project opts back in with its own testIgnore).
  testIgnore: "**/audit/**",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  // CI runners stall 10s+ on dev-mode on-demand compiles; scale the windows
  // there so a pause is absorbed while real failures still fail.
  timeout: process.env.CI ? 120_000 : 60_000,
  expect: { timeout: process.env.CI ? 25_000 : 10_000 },
  use: {
    actionTimeout: process.env.CI ? 30_000 : 15_000,
    baseURL: "http://localhost:3005",
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Responsive audit (UI-RESPONSIVE-BRIEF §4): run explicitly with
    //   playwright test --project audit
    // It is NOT part of the default suite: the top-level testIgnore keeps
    // e2e/audit out of the chromium project entirely, and unless this
    // invocation passed `--project audit` (see auditRequested above) the
    // audit specs self-skip (listed as skipped, executing nothing), so a bare
    // `playwright test` still runs exactly the 16 chromium tests. It shares
    // the isolated webServer + globalSetup — same throwaway data root on
    // :3005, never the real dev server. The sweep only records
    // e2e/audit/report.json unless AUDIT_ENFORCE=1.
    { name: "audit", testDir: "./e2e/audit", testIgnore: [], timeout: 600_000, use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "node e2e/dev-server.mjs",
    // The URL (not just the port): readiness means "/" compiled and rendered,
    // so the first tests don't race the dev server's cold compile.
    url: "http://localhost:3005/",
    reuseExistingServer: false,
    timeout: 300_000, // CI builds the app first (prod server per e2e/dev-server.mjs)
  },
});
