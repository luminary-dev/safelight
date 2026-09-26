import { expect, type Page, test } from "@playwright/test";

/** Asserts the landmark that only that mode's workspace renders. */
async function expectModeLandmark(page: Page, mode: string) {
  switch (mode) {
    case "chat":
      await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
      await expect(page.getByRole("heading", { name: /making today\?/ })).toBeVisible();
      break;
    case "image":
      await expect(page.getByRole("heading", { name: "What should we make?" })).toBeVisible();
      break;
    case "code":
      await expect(page.getByRole("heading", { name: "Point this session at a folder" })).toBeVisible();
      await expect(page.getByLabel("Workspace folder")).toBeVisible();
      break;
    case "design":
      await expect(page.getByRole("heading", { name: /making today\?/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "New session" })).toBeVisible();
      // Distinguishes Design from Code, which shares the "New session" button.
      await expect(page.getByLabel("Workspace folder")).toHaveCount(0);
      break;
    case "library":
      await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
      break;
    case "blueprints":
      await expect(page.getByRole("heading", { name: "Blueprints", exact: true })).toBeVisible();
      break;
  }
}

const MODES = ["chat", "image", "code", "design", "library", "blueprints"] as const;
const NAV_LABEL: Record<(typeof MODES)[number], string> = {
  chat: "Chat",
  image: "Image",
  code: "Code",
  design: "Design",
  library: "Library",
  blueprints: "Blueprints",
};

test("clicking through the nav renders each mode's workspace", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation");
  for (const mode of MODES) {
    await nav.getByRole("button", { name: NAV_LABEL[mode] }).click();
    await expectModeLandmark(page, mode);
  }
});

for (const mode of MODES) {
  test(`?mode=${mode} deep-links straight into ${mode}`, async ({ page }) => {
    await page.goto(`/?mode=${mode}`);
    await expectModeLandmark(page, mode);
  });
}
