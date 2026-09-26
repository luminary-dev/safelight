import { expect, type Page, test } from "@playwright/test";

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Everything in one place" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("a saved daily spend limit survives closing and reopening Settings", async ({ page }) => {
  await page.goto("/");
  let dialog = await openSettings(page);

  await dialog.getByLabel("Daily stop ($)").fill("42");
  const saved = page.waitForResponse((r) => r.url().includes("/api/settings") && r.request().method() === "PATCH" && r.ok());
  await dialog.getByRole("button", { name: "Save limits" }).click();
  await saved;
  await expect(dialog.getByText("Saved.", { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  dialog = await openSettings(page);
  await expect(dialog.getByLabel("Daily stop ($)")).toHaveValue("42");
});

test("Local only toggles the sidebar badge on and off", async ({ page }) => {
  await page.goto("/");
  const badge = page.getByText("Local only — nothing leaves this machine");
  await expect(badge).toHaveCount(0);

  const dialog = await openSettings(page);
  const toggle = dialog.getByRole("switch", { name: "Local only" });

  const turnedOn = page.waitForResponse((r) => r.url().includes("/api/settings") && r.request().method() === "PATCH" && r.ok());
  await toggle.click();
  await turnedOn;
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(badge).toBeVisible();

  const turnedOff = page.waitForResponse((r) => r.url().includes("/api/settings") && r.request().method() === "PATCH" && r.ok());
  await toggle.click();
  await turnedOff;
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(badge).toHaveCount(0);
});
