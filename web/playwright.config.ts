import { defineConfig, devices } from "@playwright/test";

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
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:3005",
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/dev-server.mjs",
    // The URL (not just the port): readiness means "/" compiled and rendered,
    // so the first tests don't race the dev server's cold compile.
    url: "http://localhost:3005/",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
