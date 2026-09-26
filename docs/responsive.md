# Responsive layout contract

Source brief: `UI-RESPONSIVE-BRIEF.md`. This document records the layout contract (§3),
the phone-range decision, the audit tooling, and the measured baseline. The audit in
`web/e2e/audit/` enforces this contract once Tier A lands (`AUDIT_ENFORCE=1`); until then
it records without failing.

## Supported widths

All of these must pass the audit: **1920, 1680, 1440, 1366, 1280, 1152, 1024, 900, 834,
768, 640, 480, 390, 360** — plus 1024 and 768 in both orientations, and 200 % browser zoom
at 1440 (an accessibility requirement, WCAG 1.4.4, not an extra).

## Phone decision (final)

| Range | Support level |
|---|---|
| ≥ 768 | **Fully supported.** Every invariant below holds. |
| 480–767 | **Degraded but usable.** Single column, one region at a time; secondary affordances may collapse into menus, but every function stays reachable. |
| < 480 | **Out of scope, with an honest in-app message.** The app must say so on screen rather than silently clip. |

Status: **final — accepted by the owner on 2026-09-26.**
Whatever the final answer, this table, the audit matrix, and `TEST-BRIEF.md` §13 must agree.

## Breakpoint semantics

Named by what changes, not by device:

| Range | Name | Composition |
|---|---|---|
| ≥ 1440 | full | Rail + composer + stage side by side, all actions inline. |
| 1280–1439 | dense | Same three regions, tighter spacing; toolbars may begin collapsing. |
| 1024–1279 | compact | Stage actions collapse to primary + overflow menu; secondary metadata hides behind a disclosure. |
| 768–1023 | stacked | Rail becomes a collapsible sheet; composer and stage stack. |
| < 768 | single column | One region at a time, explicit navigation between them. |

## Invariants (at every supported width)

- No element's bounding rect extends beyond the viewport.
- No element has `scrollWidth > clientWidth` unless it is a deliberate, labelled scroll region.
- No two interactive elements overlap.
- No text is clipped without an ellipsis and an accessible full value (`title`/`aria-label`).
- Every interactive target is ≥ 44 × 44 CSS px at ≤ 1023 px, ≥ 32 × 32 above.
- Nothing is hidden by `display: none` unless an equivalent affordance exists elsewhere.
- Silent clipping is the enemy: `overflow: hidden` that makes the detector green while
  removing function is a regression, not a fix.

## Audit tooling

- **Detector**: `web/e2e/audit/detect.ts` — injected into the page; reports
  `overflowsViewport`, `clippedX`, `clippedY`, `overlaps` (interactive pairs),
  `tinyTargets`, `truncatedNoTitle`, `zeroSize`, and `contrastFails` (WCAG AA math ported
  from `web/src/lib/theme/contrast.ts`). Skips `nextjs-portal` (the dev-mode indicator,
  brief §1.5), `[data-audit-ignore]`, aria-hidden and hidden/zero-opacity subtrees.
  Each offending element is reported once per category with a selector path, rect, and
  the measured numbers.
- **Sweep**: `web/e2e/audit/sweep.spec.ts`, Playwright project `audit`. Run from `web/`:

  ```sh
  ./node_modules/.bin/playwright test --project audit           # record only
  AUDIT_ENFORCE=1 ./node_modules/.bin/playwright test --project audit  # fail on findings
  ```

  It is not part of the default suite: `playwright test` runs the 16 chromium tests; the
  audit specs are excluded from the chromium project and self-skip unless the invocation
  explicitly passed `--project audit` (the config records that in project metadata).
- **Server**: the sweep shares the existing isolated launcher (`web/e2e/dev-server.mjs`
  via the config's `webServer`, port 3005, `reuseExistingServer: false`, throwaway empty
  data root). It never touches the real dev server (:3001), `data/`, `inputs/`, or
  `outputs/`.
- **Reports**: each run writes `web/e2e/audit/report.json` (machine-readable per-cell
  counts + capped offender lists; counts are exact, offender lists cap at 8 per category
  per cell). The committed ground truth is `web/e2e/audit/report.baseline.json`.

### Honest limitations of this round

- **Empty state only.** Populated, loading/streaming, error, and long-content stress
  states (brief §7) are the follow-up round; so are the pseudo-locale sweep and visual
  regression snapshots.
- **200 % zoom proxy.** The `1440@2x` cells run deviceScaleFactor 2 at 1440×900. That does
  **not** reflow CSS layout (the page still lays out at 1440 CSS px) — it exercises hi-DPI
  rendering only. True 200 % zoom behaves like a ~720 CSS px viewport; read the 640/768
  width columns as the zoom reflow signal until a real-zoom harness (CDP
  `Page.setDeviceMetricsOverride` or `browser.newContext({ viewport: 720 })` semantics)
  replaces the proxy.
- **Widths are swept by resizing** one loaded page per mode × theme (equivalent to a user
  resizing the window). Layout is CSS-driven today, so resize and fresh-load agree.
- **Overlays audited at 1440/1024/390 light**: Settings, API keys, MCP, Model manager,
  status panel, project switcher, model picker. Confirm-delete, the full-size viewer, and
  the mask canvas need a render (populated round); the sheet-mode rail does not exist yet
  (Tier A item 3). Overlay openers are clicked programmatically because at 390 the sidebar
  buttons themselves sit past the viewport edge — that defect is captured by the viewport
  cells.

## Measured baseline (2026-09-26, empty state)

Ground truth: `web/e2e/audit/report.baseline.json` (201 cells: 14 widths × 6 modes ×
2 themes + 12 `1440@2x` cells + 7 overlays × 3 widths; zero measurement errors; run time
1.7 min). **Grand total: 6,659 findings.** Every later sweep is measured against this.
Note: the baseline snapshot was taken 2026-09-26 ~10:17 UTC while the Tier A workstream
was landing fixes in the same working tree — a sweep a few minutes later already measured
4,940, so treat 6,659 as the pre-Tier-A mark, not the current state.

Counts per category per scope (each scope sums its cells across all widths and themes, so
one persistent offender counts once per cell it appears in):

| Scope | overflowsViewport | clippedX | clippedY | overlaps | tinyTargets | truncatedNoTitle | zeroSize | contrastFails | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| chat | 0 | 22 | 28 | 4 | 366 | 15 | 0 | 159 | 594 |
| image | 0 | 0 | 0 | 0 | 954 | 14 | 0 | 135 | 1,103 |
| code | 0 | 0 | 0 | 0 | 320 | 16 | 8 | 105 | 449 |
| design | 4 | 22 | 28 | 0 | 358 | 16 | 0 | 159 | 587 |
| library | 4 | 18 | 0 | 0 | 414 | 16 | 0 | 60 | 512 |
| blueprints | 0 | 4 | 0 | 0 | 450 | 472 | 0 | 1,800 | 2,726 |
| overlay: settings | 0 | 3 | 2 | 0 | 45 | 2 | 0 | 42 | 94 |
| overlay: keys | 0 | 3 | 2 | 8 | 146 | 2 | 0 | 56 | 217 |
| overlay: mcp | 0 | 3 | 2 | 0 | 38 | 2 | 0 | 29 | 74 |
| overlay: model-manager | 0 | 5 | 2 | 0 | 55 | 2 | 0 | 34 | 98 |
| overlay: status-panel | 0 | 3 | 2 | 1 | 45 | 2 | 0 | 20 | 73 |
| overlay: project-switcher | 0 | 3 | 2 | 1 | 36 | 2 | 0 | 23 | 67 |
| overlay: model-picker | 1 | 3 | 2 | 1 | 36 | 2 | 0 | 20 | 65 |
| **Total** | **9** | **89** | **70** | **15** | **3,263** | **563** | **8** | **2,642** | **6,659** |

Reading notes:

- **tinyTargets dominates (3,263)** because at every width ≤ 1023 the whole UI is built
  from 24–32 px controls against a 44 px touch minimum — a systemic finding, not 3,263
  separate bugs.
- **blueprints contributes 2,726** — the ~100 catalog cards multiply every per-card issue
  (low-contrast card metadata, truncated names with no `title`).
- **overflowsViewport is 9 in the empty state**: the Design "New session" button and the
  Library filter row poke past the right edge at 390/360, and the model-picker popover
  exceeds 390 by 2 px. The brief's headline §1.1 Stage action-bar overflow needs a render
  selected, so it does not appear in the empty-state baseline — it was reproduced live
  against real data (see below) and belongs to the populated round + Tier A fix.
- **§1 reproduction (real dev server, 2026-09-26, render selected, Image mode):** action
  bar spans 679 → 1569 (890 px, `shrink-0`); overflow 129 px at 1440 (Save, Open, Delete
  lost), 289 px at 1280 (Remove BG onward), 545 px at 1024 (Outpaint onward, 7 of 10);
  `document.documentElement.scrollWidth` = viewport width at every width (no scrollbar —
  silent loss). Session header row `scrollWidth` 902 vs `clientWidth` 738 / 578 / 322 at
  1440 / 1280 / 1024, `overflow-x: visible`.

## Overlay and dialog contract (Tier B, 2026-09-26)

- **Every floating primitive is viewport-aware centrally** (`ui/dialog|alert-dialog|sheet|
  popover|select|tooltip|command`): max sizes derived from `100dvh`/`100vw` minus gutters,
  Radix collision handling (`collisionPadding` 8) where applicable. Fix a floating-layer
  sizing bug in the primitive, not the call site.
- **Dialogs are a flex column with exactly one scroll region**: pinned header (with the
  Close action), pinned footer, and a `DialogBody`/`SheetBody` that owns `overflow-y`.
  Footers can never scroll away.
- **Below 768 every dialog becomes a bottom/full-height sheet** (full width, no bottom
  radius, ≥ 44 px Close). The four hand-rolled dialogs (Settings/Keys/MCP/Model manager)
  follow the same contract.
- **CompareView decision**: below 768 the drag slider is replaced by a stacked A/B toggle
  (two ≥ 44 px "Show A"/"Show B" buttons over one full-width easel), `matchMedia`-driven so
  it tracks live window resizes; the slider is unchanged at ≥ 768. A vertical slider was
  rejected — at that width the handle and the image compete for the same 390 px.
- **Library inspector** is a fixed bottom drawer (max-h 60dvh) below 1024 instead of a
  squeezed third column.

The 2026-09-26 end-of-day sweep after Tiers A+B+C measures **4,372 findings** (from the
6,659 pre-Tier-A baseline): overflowsViewport/clippedX/clippedY/overlaps/truncatedNoTitle
are all **0**; what remains is tinyTargets 2,153 (the systemic 24–32 px control scale — a
design-level decision) and contrastFails 2,211 (dominated by `--faint`/`--placeholder`
tokens on `paper-2`, ~2.5:1 — a theme-token decision), plus 8 zeroSize.

## Per-component status

"fixed (tier X)" = reworked to the contract on 2026-09-26, covered by unit tests, and
clean in that day's end sweep for its categories. Per-component zero-finding sign-off
still requires the populated/stress round.

| Component | Status |
|---|---|
| `shell.tsx`, `Sidebar.tsx`, `Safelight.tsx` | fixed (tier A) + compact-range column handoff; Sidebar's 28×28 buttons remain the last tinyTargets in every overlay cell ≤ 1024 and its session-title span lacks a truncation title — **open, Tier A owner** |
| `ChatWorkspace.tsx` / `ChatMode.tsx` | fixed (tier C) — word/URL/base64 wrapping, code-block scroll, 40dvh composer cap |
| `Composer.tsx`, `ImageControls.tsx` | fixed (tier C) — labelled pill scroll strip, sticky Generate at lg+ |
| `CodeWorkspace.tsx`, `DesignWorkspace.tsx` | fixed (tier C) — picker/chip clamps, glow width |
| `Library.tsx` / `library/LibraryGrid.tsx` | fixed (tier B) — wrapping filter/bulk rows, touch equivalents for hover actions |
| `BlueprintsWorkspace.tsx`, `BlueprintRunner.tsx` | fixed (tier C) — accessible truncation, per-width grids/forms; card-metadata contrast remains (theme tokens) |
| `SettingsDialog.tsx`, `KeysDialog.tsx`, `McpDialog.tsx`, `ModelManagerDialog.tsx` | fixed (tier B) — sheet-mode contract; Keys also gained its focus trap and the eye moved out of the input rect |
| `ModelPicker.tsx` | fixed (tier C + central popover clamp) — viewport-capped, full names in titles |
| `ProjectSwitcher.tsx`, `FolderBrowser.tsx` | fixed (tier B) — modal popover, path/name titles; one overlap remains inside ProjectSwitcher at 1024 |
| Status panel popover (`Sidebar.tsx`) | improved by central clamps; remaining findings are the Sidebar tinyTargets |
| `Stage.tsx` | fixed (tier A action bar + tier C letterboxing) |
| `ConfirmDelete.tsx` | fixed (tier B, by inspection + test) — sweep still can't reach it (needs a render fixture) |
| Full-size viewer, `MaskCanvas.tsx` | fixed (tier B, by test: pointer mapping after resize/DPR, focus trap, Escape) — sweep still can't reach it |
| `RunQueue.tsx` | fixed (tier B, by test) — sweep needs queued runs |
| `library/Inspector.tsx`, `CompareView.tsx`, `DuplicatesView.tsx` | fixed (tier B) — drawer / A/B toggle / touch sizing; verified live against a populated library at 768 |
| `ThemeToggle.tsx`, remaining `ui/` primitives | central viewport clamps (tier B); unaudited individually |
| Populated / loading / error / stress states, pseudo-locale, both orientations, visual regression | unaudited — follow-up round |
