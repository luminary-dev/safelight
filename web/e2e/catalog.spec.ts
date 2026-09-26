import { expect, test } from "@playwright/test";

test("Library shows its empty state against the throwaway data dir", async ({ page }) => {
  await page.goto("/?mode=library");
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  // The run's tmp outputs folder holds no renders, so the honest empty state shows.
  await expect(page.getByText("Nothing here yet.")).toBeVisible();
});

test("Blueprints catalog lists >100 workflows, honestly Unknown while ComfyUI is down", async ({ page }) => {
  await page.goto("/?mode=blueprints");
  await expect(page.getByRole("heading", { name: "Blueprints", exact: true })).toBeVisible();

  // The registry parses from the repo's comfyui/blueprints folder.
  const status = page.getByRole("status").filter({ hasText: "workflows from the render engine" });
  await expect(status).toBeVisible();
  const text = (await status.textContent()) ?? "";
  const count = Number(/(\d+) workflows/.exec(text)?.[1] ?? 0);
  expect(count).toBeGreaterThan(100);

  // ComfyUI is unreachable on purpose, so readiness is honestly unknown — not "ready".
  await expect(status).toContainText("ComfyUI is offline, readiness unknown");
  await expect(status).toContainText("0 ready on this machine");
  const unknownChips = page.getByText("Unknown", { exact: true });
  await expect(unknownChips.nth(100)).toBeVisible();
  await expect(page.getByText("Ready", { exact: true })).toHaveCount(0);
});
