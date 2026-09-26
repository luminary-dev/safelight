import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("Library shows its empty state against the throwaway data dir", async ({ page }) => {
  await page.goto("/?mode=library");
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  // The run's tmp outputs folder holds no renders, so the honest empty state shows.
  await expect(page.getByText("Nothing here yet.")).toBeVisible();
});

// The registry parses the local ComfyUI clone's blueprints; that clone is gitignored, so a
// CI checkout has no catalog. Locally the full catalog is asserted; in CI the honest empty
// state is — the test is about honesty in both environments, never a skip.
const HAS_BLUEPRINTS = existsSync(path.resolve(__dirname, "..", "..", "comfyui", "blueprints"));

test("Blueprints catalog is honest while ComfyUI is down", async ({ page }) => {
  await page.goto("/?mode=blueprints");
  await expect(page.getByRole("heading", { name: "Blueprints", exact: true })).toBeVisible();

  const status = page.getByRole("status").filter({ hasText: "workflows from the render engine" });
  await expect(status).toBeVisible();
  const text = (await status.textContent()) ?? "";
  const count = Number(/(\d+) workflows/.exec(text)?.[1] ?? 0);

  if (HAS_BLUEPRINTS) {
    // Full local catalog, readiness honestly unknown — never "ready" with ComfyUI down.
    expect(count).toBeGreaterThan(100);
    await expect(status).toContainText("ComfyUI is offline, readiness unknown");
    await expect(status).toContainText("0 ready on this machine");
    const unknownChips = page.getByText("Unknown", { exact: true });
    await expect(unknownChips.nth(100)).toBeVisible();
  } else {
    // No vendored engine in this checkout: zero workflows claimed, none "ready".
    expect(count).toBe(0);
  }
  await expect(page.getByText("Ready", { exact: true })).toHaveCount(0);
});
