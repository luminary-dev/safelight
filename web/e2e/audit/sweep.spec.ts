/**
 * Responsive audit sweep (UI-RESPONSIVE-BRIEF §4) — runs ONLY under the
 * `audit` Playwright project:
 *
 *     ./node_modules/.bin/playwright test --project audit
 *
 * Matrix, this round: 14 widths (§3) plus 1440@2x-deviceScaleFactor as the
 * 200 % zoom proxy, × 6 modes × 2 themes (?theme=), EMPTY state only, plus the
 * §4 overlays at 1440/1024/390 light. Populated / loading / error /
 * long-content stress states are the follow-up round (see docs/responsive.md).
 *
 * Honest notes on method:
 * - Server: shares the existing isolated launcher (e2e/dev-server.mjs via the
 *   top-level webServer, :3005, throwaway data root, reuseExistingServer:
 *   false). It never touches the real dev server (:3001) or real data/.
 * - Widths are swept by resizing the viewport per mode×theme page load (same
 *   as a user resizing a window). Layout here is CSS-driven, so resize and
 *   fresh-load agree; if JS-measured layout lands later, switch to per-width
 *   loads.
 * - 200 % zoom proxy: deviceScaleFactor 2 at 1440 does NOT reflow CSS layout
 *   (the page still lays out at 1440 CSS px) — it exercises hi-DPI rendering
 *   only. True 200 % zoom behaves like a ~720 CSS px viewport, which the
 *   640/768 width cells approximate. Recorded as `1440@2x` and documented in
 *   docs/responsive.md; treat the 640/768 columns as the zoom reflow signal.
 * - Overlay openers are clicked programmatically (element.click() in-page):
 *   at 390 the sidebar buttons themselves sit past the viewport edge — that
 *   defect is recorded by the viewport cells; the overlay cells measure the
 *   overlay itself.
 * - Confirm-delete, the full-size viewer, the mask canvas, and the sheet-mode
 *   rail need a render / a narrow-mode rail that the empty state cannot
 *   produce; they are recorded in `skippedOverlays` for the populated round.
 *
 * The run records e2e/audit/report.json and NEVER fails on findings unless
 * AUDIT_ENFORCE=1 — it is a baseline tool until Tier A lands.
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { auditPage, CATEGORIES, type AuditResult, type Category } from "./detect";

test.describe.configure({ mode: "serial" });

const MAX_OFFENDERS = 8; // per category per cell; counts stay exact

// width → height (heights follow common devices at that width)
const WIDTHS: [number, number][] = [
  [1920, 1080],
  [1680, 1050],
  [1440, 900],
  [1366, 768],
  [1280, 800],
  [1152, 864],
  [1024, 768],
  [900, 1280],
  [834, 1112],
  [768, 1024],
  [640, 960],
  [480, 853],
  [390, 844],
  [360, 780],
];

const MODES = ["chat", "image", "code", "design", "library", "blueprints"] as const;
type Mode = (typeof MODES)[number];
const THEMES = ["light", "dark"] as const;

/** Empty-state landmark per mode (mirrors e2e/modes.spec.ts). */
const LANDMARK: Record<Mode, { name: string | RegExp; exact?: boolean }> = {
  chat: { name: /making today\?/ },
  image: { name: "What should we make?" },
  code: { name: "Point this session at a folder" },
  design: { name: /making today\?/ },
  library: { name: "Library", exact: true },
  blueprints: { name: "Blueprints", exact: true },
};

interface Cell {
  id: string;
  kind: "viewport" | "overlay";
  mode: Mode;
  theme: (typeof THEMES)[number];
  width: number;
  height: number;
  deviceScaleFactor: number;
  overlay?: string;
  documentScrollWidth?: number;
  counts?: AuditResult["counts"];
  offenders?: AuditResult["offenders"];
  error?: string;
}

const cells: Cell[] = [];

const record = (cell: Omit<Cell, "counts" | "offenders" | "documentScrollWidth">, res: AuditResult) => {
  cells.push({ ...cell, documentScrollWidth: res.documentScrollWidth, counts: res.counts, offenders: res.offenders });
};

// The sweep runs only when this invocation explicitly asked for the audit
// project — the config's main-process evaluation records that in
// SAFELIGHT_AUDIT, which workers inherit (see playwright.config.ts). A bare
// `playwright test` lists these tests as skipped and executes nothing.
const skipUnlessAudit = () => test.skip(test.info().project.name !== "audit" || process.env.SAFELIGHT_AUDIT !== "1", "Audit-only: run with `playwright test --project audit`");
const baseURL = () => (test.info().project.use.baseURL as string | undefined) ?? "http://localhost:3005";

test("viewport sweep: widths × modes × themes, empty state", async ({ browser }) => {
  skipUnlessAudit();
  for (const mode of MODES) {
    for (const theme of THEMES) {
      const context = await browser.newContext({ viewport: { width: WIDTHS[0][0], height: WIDTHS[0][1] }, reducedMotion: "reduce", baseURL: baseURL() });
      const page = await context.newPage();
      try {
        await page.goto(`/?mode=${mode}&theme=${theme}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("heading", LANDMARK[mode]).first().waitFor({ state: "attached", timeout: 30_000 });
        await page.waitForTimeout(300);
        for (const [width, height] of WIDTHS) {
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(200);
          const res = await page.evaluate(auditPage, { maxOffenders: MAX_OFFENDERS });
          record({ id: `${mode}/${theme}/${width}`, kind: "viewport", mode, theme, width, height, deviceScaleFactor: 1 }, res);
        }
      } catch (err) {
        cells.push({ id: `${mode}/${theme}/*`, kind: "viewport", mode, theme, width: 0, height: 0, deviceScaleFactor: 1, error: String(err) });
      } finally {
        await context.close();
      }
    }
  }
});

test("200% zoom proxy: 1440 at deviceScaleFactor 2 (see honest note in header)", async ({ browser }) => {
  skipUnlessAudit();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce", baseURL: baseURL() });
  const page = await context.newPage();
  try {
    for (const mode of MODES) {
      for (const theme of THEMES) {
        try {
          await page.goto(`/?mode=${mode}&theme=${theme}`, { waitUntil: "domcontentloaded" });
          await page.getByRole("heading", LANDMARK[mode]).first().waitFor({ state: "attached", timeout: 30_000 });
          await page.waitForTimeout(300);
          const res = await page.evaluate(auditPage, { maxOffenders: MAX_OFFENDERS });
          record({ id: `${mode}/${theme}/1440@2x`, kind: "viewport", mode, theme, width: 1440, height: 900, deviceScaleFactor: 2 }, res);
        } catch (err) {
          cells.push({ id: `${mode}/${theme}/1440@2x`, kind: "viewport", mode, theme, width: 1440, height: 900, deviceScaleFactor: 2, error: String(err) });
        }
      }
    }
  } finally {
    await context.close();
  }
});

/** §4 overlays reachable from the empty state, opened at 1440 / 1024 / 390, light. */
const OVERLAYS: { name: string; opener: string }[] = [
  { name: "settings", opener: 'button[aria-label="Settings"]' },
  { name: "keys", opener: 'button[aria-label="API keys"]' },
  { name: "mcp", opener: 'button[aria-label="MCP servers"]' },
  { name: "model-manager", opener: 'button[aria-label="Model manager"]' },
  { name: "status-panel", opener: 'button[aria-label="System status"]' },
  { name: "project-switcher", opener: 'button[class*="max-w-[160px]"]' },
  { name: "model-picker", opener: 'button[aria-label="Pick a chat model"]' },
];
const SKIPPED_OVERLAYS = ["confirm-delete (needs a render — populated round)", "full-size viewer (needs a render — populated round)", "mask canvas (needs a render — populated round)", "sheet-mode rail (does not exist yet — Tier A §5.3)"];
const OVERLAY_WIDTHS: [number, number][] = [
  [1440, 900],
  [1024, 768],
  [390, 844],
];
const OVERLAY_SURFACE = '[role="dialog"], [data-radix-popper-content-wrapper]';

test("overlays: dialogs and popovers at 1440/1024/390, light", async ({ browser }) => {
  skipUnlessAudit();
  for (const [width, height] of OVERLAY_WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", baseURL: baseURL() });
    const page = await context.newPage();
    const url = "/?mode=chat&theme=light"; // chat: the model-picker trigger lives in its header
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", LANDMARK.chat).first().waitFor({ state: "attached", timeout: 30_000 });
      await page.waitForTimeout(300);
      for (const overlay of OVERLAYS) {
        const cell: Cell = { id: `overlay/${overlay.name}/${width}`, kind: "overlay", mode: "chat", theme: "light", width, height, deviceScaleFactor: 1, overlay: overlay.name };
        try {
          const opened = await page.evaluate((sel) => {
            const el = document.querySelector<HTMLElement>(sel);
            if (!el) return false;
            el.click();
            return true;
          }, overlay.opener);
          if (!opened) {
            cells.push({ ...cell, error: `opener not found: ${overlay.opener}` });
            continue;
          }
          await page.locator(OVERLAY_SURFACE).first().waitFor({ state: "visible", timeout: 10_000 });
          await page.waitForTimeout(250);
          const res = await page.evaluate(auditPage, { maxOffenders: MAX_OFFENDERS });
          record(cell, res);
        } catch (err) {
          cells.push({ ...cell, error: String(err) });
        }
        // Close and reset: Escape first; if the surface lingers, reload.
        await page.keyboard.press("Escape");
        await page.waitForTimeout(250);
        if (await page.locator(OVERLAY_SURFACE).first().isVisible().catch(() => false)) {
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page.getByRole("heading", LANDMARK.chat).first().waitFor({ state: "attached", timeout: 30_000 });
          await page.waitForTimeout(300);
        }
      }
    } finally {
      await context.close();
    }
  }
});

test.afterAll(async () => {
  // cells only accumulate when the audit project actually ran (the tests
  // self-skip under every other project), so an empty list means: no report.
  if (cells.length === 0) return;

  const zero = () => Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const totals = zero();
  const totalsByMode: Record<string, Record<Category, number>> = {};
  for (const cell of cells) {
    if (!cell.counts) continue;
    const scope = cell.kind === "overlay" ? `overlay:${cell.overlay}` : cell.mode;
    totalsByMode[scope] ??= zero();
    for (const cat of CATEGORIES) {
      totals[cat] += cell.counts[cat];
      totalsByMode[scope][cat] += cell.counts[cat];
    }
  }
  const errors = cells.filter((c) => c.error).map((c) => ({ id: c.id, error: c.error }));
  const grandTotal = CATEGORIES.reduce((sum, c) => sum + totals[c], 0);

  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    server: "isolated e2e dev server (e2e/dev-server.mjs → :3005, throwaway empty data root; never :3001 or real data/)",
    state: "empty",
    zoomProxy: "1440@2x = deviceScaleFactor 2 at 1440×900. This does NOT reflow CSS layout (still 1440 CSS px); true 200% zoom ≈ a ~720 CSS px viewport — read the 640/768 width cells for the zoom reflow signal.",
    matrix: {
      widths: WIDTHS.map(([w]) => w),
      zoomProxy: "1440@2x",
      modes: MODES,
      themes: THEMES,
      states: ["empty"],
      overlays: OVERLAYS.map((o) => o.name),
      overlayWidths: OVERLAY_WIDTHS.map(([w]) => w),
      skippedOverlays: SKIPPED_OVERLAYS,
      maxOffendersPerCategoryPerCell: MAX_OFFENDERS,
    },
    grandTotal,
    totals,
    totalsByMode,
    errors,
    cells,
  };

  const out = path.join(__dirname, "report.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 1));

  const pad = (s: string | number, n: number) => String(s).padStart(n);
  console.log(`\n[audit] ${cells.length} cells → ${out}`);
  console.log(`[audit] ${"category".padEnd(20)}${pad("total", 8)}`);
  for (const cat of CATEGORIES) console.log(`[audit] ${cat.padEnd(20)}${pad(totals[cat], 8)}`);
  console.log(`[audit] ${"GRAND TOTAL".padEnd(20)}${pad(grandTotal, 8)}`);
  if (errors.length) console.log(`[audit] cells with errors: ${errors.map((e) => e.id).join(", ")}`);

  if (process.env.AUDIT_ENFORCE === "1") {
    expect(grandTotal, `AUDIT_ENFORCE=1: expected zero findings across all categories, got ${grandTotal} — see ${out}`).toBe(0);
    expect(errors, "AUDIT_ENFORCE=1: some cells failed to measure").toEqual([]);
  }
});
