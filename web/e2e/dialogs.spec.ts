import { expect, test } from "@playwright/test";

/**
 * A11y smoke for the three utility dialogs: each opens from its sidebar button,
 * closes on Escape, and focus lands back on the button that opened it.
 */
const DIALOGS = [
  { opener: "API keys", heading: "Connect cloud models" },
  { opener: "MCP servers", heading: "Extend the agents" },
  { opener: "Model manager", heading: "Get models" },
] as const;

for (const { opener, heading } of DIALOGS) {
  test(`${opener} dialog: Escape closes and focus returns to the opener`, async ({ page }) => {
    await page.goto("/");
    const button = page.getByRole("button", { name: opener, exact: true });
    await button.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: heading })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
  });
}
