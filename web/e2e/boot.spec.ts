import { expect, test } from "@playwright/test";

test("app boots: six nav entries and an honest status pill", async ({ page }) => {
  await page.goto("/");

  // All six modes appear in the sidebar nav.
  const nav = page.getByRole("navigation");
  for (const entry of ["Chat", "Image", "Code", "Design", "Library", "Blueprints"]) {
    await expect(nav.getByRole("button", { name: entry, exact: entry !== "Library" })).toBeVisible();
  }

  // With ComfyUI and Ollama both unreachable and no keys configured, the pill must
  // settle on the honest "nothing works" label for the default (image) mode — and
  // never claim readiness.
  const pill = page.getByRole("button", { name: "System status" });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText(/Nothing to render with/, { timeout: 20_000 });
  await expect(pill).not.toContainText("Ready to render");

  // The status popover names both local backends as offline. The pill click
  // toggles a popover and can race a health-poll re-render, so retry the
  // click-then-check as one unit instead of sleeping.
  await expect(async () => {
    await pill.click();
    await expect(page.getByText("Offline · run pnpm comfy")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByText("Offline · run ollama serve")).toBeVisible();
});
