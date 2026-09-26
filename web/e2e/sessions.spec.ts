import { expect, type Page, test } from "@playwright/test";

/**
 * Create → rename → delete a chat session through the sidebar, reloading after
 * every mutation: each step is asserted against a fresh page, so what the
 * sidebar shows is exactly what the sessions API persisted into the run's
 * throwaway SQLite — not React state. (The reloads also sidestep dev-mode
 * StrictMode double-fetches of /api/sessions racing optimistic inserts.)
 */

/** Navigates to chat mode and waits for the boot fetch of /api/sessions. */
async function gotoChat(page: Page) {
  const loaded = page.waitForResponse((r) => r.url().includes("/api/sessions") && r.request().method() === "GET");
  await page.goto("/?mode=chat");
  await loaded;
}

test("chat session lifecycle: create, rename, delete, all server-backed", async ({ page }) => {
  await gotoChat(page);
  const sidebar = page.getByRole("complementary");
  await expect(sidebar.getByText("Your first message starts a chat.")).toBeVisible();

  // Create via the sidebar's New button; the reload proves the POST persisted.
  const created = page.waitForResponse((r) => r.url().includes("/api/sessions") && r.request().method() === "POST" && r.ok());
  await sidebar.getByRole("button", { name: "New", exact: true }).click();
  await created;
  await gotoChat(page);
  const row = sidebar.getByRole("button", { name: "New chat", exact: true });
  await expect(row).toBeVisible();

  // Rename in place; the reload proves the PATCH persisted. Each step asserts
  // its own effect so a missed click fails fast instead of a 60s response wait.
  await row.hover();
  const rename = sidebar.getByRole("button", { name: "Rename" });
  await expect(rename).toBeVisible();
  await rename.click();
  const title = sidebar.getByLabel("Session title");
  await expect(title).toBeVisible();
  const patched = page.waitForResponse((r) => r.url().includes("/api/sessions/") && r.request().method() === "PATCH" && r.ok());
  await title.fill("Renamed by e2e");
  await title.press("Enter");
  await expect(title).toBeHidden(); // the edit closed — Enter actually submitted
  await patched;
  await expect(sidebar.getByRole("button", { name: "Renamed by e2e" })).toBeVisible();
  await gotoChat(page);
  await expect(sidebar.getByRole("button", { name: "Renamed by e2e" })).toBeVisible();

  // Delete through the ConfirmDelete flow; the reload proves it stuck.
  await sidebar.getByRole("button", { name: "Renamed by e2e" }).hover();
  await sidebar.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete this chat?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Renamed by e2e");
  const deleted = page.waitForResponse((r) => r.url().includes("/api/sessions/") && r.request().method() === "DELETE" && r.ok());
  await dialog.getByRole("button", { name: "Delete" }).click();
  await deleted;
  await expect(sidebar.getByRole("button", { name: "Renamed by e2e" })).toHaveCount(0);
  await gotoChat(page);
  await expect(sidebar.getByText("Your first message starts a chat.")).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Renamed by e2e" })).toHaveCount(0);
});
