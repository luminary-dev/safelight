# Safelight — Responsive & Visual Integrity Brief

**Hand this entire file to the agent as its opening prompt.** Third in the set, after
`BUILD-BRIEF.md` (what to build) and `TEST-BRIEF.md` (how to prove it works). This one is
narrower and concrete: make every view work at every supported width, and check every
element for overlap, clipping, and cut-off — one by one, not by spot-check.

**Findings below were measured in a real browser against the running dev server on
2026-09-26**, not inferred from CSS. Reproduce them before you change anything.

---

## 0. Rules

1. **Measure, don't eyeball.** Every claimed fix must be backed by the detector in §4
   reporting zero for that element at every breakpoint. A screenshot that "looks fine" is
   not evidence.
2. **Silent clipping is the enemy.** At every width tested, `document.documentElement.scrollWidth`
   equalled the viewport width — so the page never grows a horizontal scrollbar. Content that
   overflows is simply *invisible and unreachable*. That is strictly worse than a scrollbar,
   because nothing signals the loss. Treat "no horizontal scroll" as a trap, not a pass.
3. **Never fix by hiding.** `overflow: hidden` on a parent makes the detector green and the
   product worse. A control that does not fit must wrap, collapse into a menu, scroll in a
   labelled strip, or be removed by design decision — never be clipped away.
4. **Preserve the design language.** `globals.css` tokens, radii, type scale, and spacing are
   settled. Responsive work changes layout and composition, not the palette or the voice.
5. **Fix the cause, not the instance.** Most of these defects share one root (§2). Patching
   each component separately will regress; establish the layout primitives first.
6. **Every fix ships with a regression test** (§10). This brief's whole point is that the
   next feature cannot silently reintroduce the same class of bug.

---

## 1. Verified findings

### 1.1 The Stage action bar is cut off at every width — including 1440

The row of image actions in Image mode is a **fixed 890 px `shrink-0` flex row** that begins
at x≈679 (after the composer column). It never shrinks, never wraps, and the page never
scrolls, so its right-hand buttons are silently unreachable.

Element: `div.flex.shrink-0.items-center.gap-2` containing
`Recreate · Vary · Inpaint · Outpaint · Upscale 4× · Remove BG · Edit · Save · Open · Delete`.

| Viewport | Bar spans | Overflow | Actions lost |
|---|---|---|---|
| 1440 × 900 | 679 → 1569 | **129 px** | Save, Open, Delete |
| 1280 × 800 | 679 → 1569 | **289 px** | Remove BG, Edit, Save, Open, Delete |
| 1024 × 768 | 679 → 1569 | **545 px** | Outpaint, Upscale, Remove BG, Edit, Save, Open, Delete — **7 of 10** |
| 768 × 1024 | 47 → 937 | 169 px | Edit, Save, Open, Delete |
| 390 × 844 | 47 → 937 | 547 px | Outpaint onward |

**Delete and Save — a destructive action and the primary export — are unreachable on a
1440 px laptop.** This is the single most serious defect in the app and it is not a narrow-
viewport edge case; 1440 is the most common laptop width there is.

### 1.2 Session titles overflow their row at every width

`div.flex.items-center.justify-between.gap-3` in the session header has `scrollWidth 902`
against a client width of 738 (1440) / 618 (1280) / 362 (1024) / 322 (390), with
`overflow-x: visible`. Auto-generated titles like `gemini_2026-09-24T20-23-56-06` have no
break opportunity and no `truncate`, so they push the row wide and spill over neighbours.

This is the generic case of **unbounded user/generated text in a fixed row** — the same bug
will exist wherever a prompt, filename, model name, project name, or folder path is rendered
without `min-w-0` + `truncate`.

### 1.3 Responsive variants are essentially absent

Count of Tailwind breakpoint prefixes (`sm:` `md:` `lg:` `xl:` `2xl:`) per component:

| Component | Variants |
|---|---|
| `ui/alert-dialog.tsx` | 9 |
| `Safelight.tsx` | 4 |
| `ui/dialog.tsx`, `ChatMode.tsx` | 3 |
| `Stage.tsx`, `Composer.tsx`, `BlueprintsWorkspace.tsx`, `ui/sheet.tsx`, `ui/button.tsx`, `ui/toggle.tsx` | 2 |
| `ImageControls.tsx`, `ui/input.tsx`, `ui/textarea.tsx`, `ui/input-group.tsx` | 1 |
| **`Sidebar.tsx`, `shell.tsx`, `SettingsDialog.tsx`, `ModelPicker.tsx`, `KeysDialog.tsx`, `McpDialog.tsx`, `ModelManagerDialog.tsx`, `RunQueue.tsx`, `MaskCanvas.tsx`, `library/LibraryGrid.tsx`, `library/Inspector.tsx`, `library/CompareView.tsx`, `library/DuplicatesView.tsx`, `ProjectSwitcher.tsx`, `FolderBrowser.tsx`, `ThemeToggle.tsx`, and all remaining `ui/` primitives** | **0** |

The shell, the rail, every dialog, and the entire Library subsystem have **no responsive
handling at all**. What reflow exists below 768 comes from the grid in `Safelight.tsx`
collapsing to a stack — which does work, and is the one piece to build on.

### 1.4 What is already fine — do not "fix" these

- **Library and Blueprints at 1024 reported zero overflowing elements.** Whatever those
  views do, they do it correctly; use them as the internal reference.
- Below 768 the two-column split **does** stack vertically into cards. The stacking is
  correct; the contents of the stacked cards are not.

### 1.5 Known false positive — exclude it from tooling

The floating dark circle at bottom-left is `<nextjs-portal>`, the Next.js dev-mode
indicator. It is not app UI and does not exist in a production build. **Every audit script
must skip `el.closest('nextjs-portal')`** or it will report a permanent phantom overlap over
the composer and the memory warning.

---

## 2. Root cause, and the fix to make first

Three patterns produce nearly every defect above:

1. **`shrink-0` on a container that must shrink.** It is correct on an icon; it is wrong on
   a toolbar. The Stage action bar is `shrink-0` around ten growing buttons.
2. **No `min-w-0` on flex children that hold text.** A flex item's default `min-width: auto`
   refuses to shrink below its content, so one long title widens the whole row. Every
   text-bearing flex child needs `min-w-0`, and the text itself needs `truncate` or
   `line-clamp-*`.
3. **A fixed desktop composition with no breakpoint variants**, so the only adaptation
   available is clipping.

**Before touching individual components, build three primitives** in `components/ui/` and
use them everywhere:

- **`<ActionBar>`** — a responsive toolbar. Above a threshold it lays actions out inline;
  below it, it keeps the top N primary actions visible and collapses the rest into an
  overflow "More" menu. Destructive actions are never the ones collapsed silently, and the
  component must never clip. This single component fixes §1.1 and every future toolbar.
- **`<TruncatedText>`** (or a documented `min-w-0 truncate` pair) — text that shrinks, ends
  in an ellipsis, and exposes the full value as a `title`/tooltip. Fixes §1.2 everywhere.
- **`<ScrollStrip>`** — for rows that genuinely need to stay one line (filmstrip, tag row,
  chips), a horizontally scrollable strip with visible edge affordance and keyboard access.
  Scrolling is an acceptable answer; clipping is not.

---

## 3. The layout contract

Decide and write these down in `docs/responsive.md`; the audit enforces them.

**Supported widths (all must pass):** 1920, 1680, 1440, 1366, 1280, 1152, 1024, 900, 834,
768, 640, 480, 390, 360. Plus 1024 and 768 in **both orientations**, and 200 % browser zoom
at 1440 (which behaves as ~720 CSS px and is an accessibility requirement, not an extra).

**Decide explicitly, in writing:** is the phone range (360–480) *supported*, *degraded but
usable*, or *out of scope with an honest message*? Right now the app neither works nor says
it does not. Any of the three answers is defensible; silence is not. Whatever you choose,
`docs/responsive.md` and the test matrix must say so, and `TEST-BRIEF.md` §13 must match.

**Breakpoint semantics** — name them by what changes, not by device:
- `≥1440` — full: rail + composer + stage side by side, all actions inline.
- `1280–1439` — dense: same three regions, tighter spacing, toolbar may begin collapsing.
- `1024–1279` — compact: stage actions collapse to primary + overflow menu; secondary
  metadata hides behind a disclosure.
- `768–1023` — stacked: rail becomes a collapsible sheet; composer and stage stack.
- `<768` — single column: one region at a time, explicit navigation between them.

**Invariants at every width:**
- No element's bounding rect extends beyond the viewport.
- No element has `scrollWidth > clientWidth` unless it is a deliberate, labelled scroll region.
- No two interactive elements overlap.
- No text is clipped without an ellipsis and an accessible full value.
- Every interactive target is ≥ 44 × 44 CSS px at ≤ 1023, ≥ 32 × 32 above.
- Nothing is hidden by `display: none` unless an equivalent affordance exists elsewhere.

---

## 4. The audit tooling — build this before fixing anything

The per-element sweep has to be automated; thirty components across fourteen widths in two
themes is ~840 view-states and no one checks that by hand twice.

**`e2e/audit/detect.ts`** — injected into the page, returns for the current view:

```
overflowsViewport[]  element rect extends past the viewport (right > vw, left < 0,
                     bottom > vh for fixed/sticky elements)
clippedX[] / clippedY[]  scrollWidth/Height > clientWidth/Height where overflow is
                     hidden|visible|clip — i.e. content lost with no scroll affordance
overlaps[]           pairs of interactive elements (button, a, input, select, textarea,
                     [role=button], [tabindex]) whose rects intersect
tinyTargets[]        interactive elements below the touch-target minimum for this width
truncatedNoTitle[]   text-overflow: ellipsis is active but no title/aria-label carries
                     the full value
zeroSize[]           interactive elements with width or height 0 that are not
                     deliberately hidden
contrastFails[]      computed fg/bg below WCAG AA (shares the checker with
                     lib/theme/contrast.ts)
```

Every rule **must** skip `el.closest('nextjs-portal')` (§1.5) and elements inside
`[data-audit-ignore]`, and must ignore `visibility: hidden` / `display: none` subtrees and
zero-opacity transition states.

**`e2e/audit/sweep.spec.ts`** — a Playwright matrix over:
`widths × modes × themes × states`, where

- **widths**: the 14 from §3, plus 200 % zoom at 1440
- **modes**: Chat, Image, Code, Design, Library, Blueprints (and Video/Audio when they land)
- **themes**: light and dark
- **states**: empty · populated · loading/streaming · error · long-content stress (§7)
- **overlays**: each dialog (Settings, Keys, MCP, Model manager, Confirm delete), each
  popover (model picker, project switcher, status panel), the full-size viewer, the mask
  canvas, and the sheet-mode rail

For each cell: run the detector, attach a screenshot on failure, and write a machine-readable
report to `e2e/audit/report.json`. **Fail the run on any non-empty category.**

Seed data from a fixture so "populated" is reproducible — reuse the throwaway-data-root
pattern in `e2e/dev-server.mjs`. Do not audit against the developer's real `data/`.

---

## 5. Element-by-element worklist

Work through every component. For each: check it at all widths, in both themes, in all five
states, then record its status in `docs/responsive.md`. The order below is by measured risk.

**Tier A — known broken**
1. **`Stage.tsx`** — the action bar (§1.1). Replace with `<ActionBar>`: keep Edit and Save
   inline longest, collapse Inpaint/Outpaint/Upscale/Remove BG into "More", and put Delete
   in the overflow menu with its confirm (destructive actions should not be one mis-click
   from a shrinking toolbar). Also: the render card's aspect handling at extreme viewport
   ratios, the filmstrip as a `<ScrollStrip>`, and progress text that must not reflow the card.
2. **Session header row** (in `Sidebar.tsx` / the workspace headers) — §1.2. `min-w-0` +
   `truncate` + `title`, and give auto-titles a break opportunity.
3. **`Sidebar.tsx`** (0 variants) — becomes a collapsible sheet below 1024: a trigger in the
   header, focus trap, Escape to close, restores focus, and does not scroll the body behind
   it. The mode rail, session list, search, project pill, and status block all need their own
   narrow-width treatment.
4. **`shell.tsx`** (0 variants) — owns the region grid; it is where the breakpoint semantics
   in §3 are implemented.

**Tier B — zero responsive handling, complex content**
5. `SettingsDialog.tsx` — the largest dialog; tabbed sections must become a stacked or
   accordion layout below 768, and the dialog itself must never exceed `100dvh` or clip its
   footer actions.
6. `ModelManagerDialog.tsx` — tables and progress rows; long model names and paths.
7. `McpDialog.tsx`, `KeysDialog.tsx` — form rows with long values; never reveal a key.
8. `library/LibraryGrid.tsx` — column count per width; virtualisation must survive resize.
9. `library/Inspector.tsx` — metadata panel becomes a sheet or a bottom drawer when narrow.
10. `library/CompareView.tsx` — the two-up slider needs a stacked mode; it cannot be two-up
    at 390.
11. `library/DuplicatesView.tsx` — groups wrap rather than scroll off.
12. `RunQueue.tsx` — a long queue with long prompts; each row is a truncation case.
13. `MaskCanvas.tsx` — canvas must map pointer coordinates correctly **after** a resize and
    at non-integer device pixel ratios; test at 200 % zoom specifically.
14. `BlueprintsWorkspace.tsx` / `BlueprintRunner.tsx` — ~100 catalog cards and generated
    forms whose field count varies per blueprint; the widest blueprint form is the test case.

**Tier C — composition and controls**
15. `ChatMode.tsx` — message bubbles with long unbroken strings (URLs, base64, stack traces)
    need `overflow-wrap: anywhere`; code blocks scroll rather than widen the column; tool
    cards, the approval prompt, and attachment chips all need narrow layouts; the composer
    grows with content but must cap and scroll.
16. `Composer.tsx` / `ImageControls.tsx` — the aspect and megapixel pill rows are prime
    `<ScrollStrip>` candidates; "More settings" must not push Generate off-screen; the
    Generate button stays reachable at every width.
17. `ModelPicker.tsx` — the popover must not exceed the viewport, must flip and shift, and
    its grouped list needs a max height with internal scroll.
18. `ProjectSwitcher.tsx`, `FolderBrowser.tsx` — long project names and deep absolute paths.
19. `ChatWorkspace.tsx`, `CodeWorkspace.tsx`, `DesignWorkspace.tsx` — each header row mixes a
    model picker, a path input, and buttons: classic wrap-or-collapse rows.
20. `ui/` primitives — `popover`, `select`, `command`, `tooltip`, `sheet`, `dialog`,
    `toggle-group`, `scroll-area`: give each a viewport-aware max size and collision handling
    once, centrally, so every consumer inherits it.

---

## 6. Overlays, popovers, and dialogs

Every floating surface gets the same treatment:
- Never exceeds `min(viewport - 2×gutter, its natural size)`; never taller than `100dvh`.
- Collision-aware: flips and shifts to stay on screen at every width, including when its
  trigger is near an edge.
- Below 768, a dialog becomes a full-height sheet with its actions pinned and always visible.
- The scrollable region is the body, never the whole dialog, so the footer cannot scroll away.
- Body scroll is locked while open, focus is trapped, Escape closes, focus returns to trigger.
- Test each with its **longest realistic content** (see §7), not its empty state.

---

## 7. Content stress — the states that break layouts

Every view must hold up with:
- A 4,000-character prompt with no spaces; a 300-character single "word"; a bare URL 200
  characters long.
- Session/project titles at 200 characters, and the real generated form
  `gemini_2026-09-24T20-23-56-06`.
- Absolute paths 300 characters deep in Code mode.
- A 200-message chat; a 500-image library; 100+ blueprints; 40 projects; 20 queued runs.
- Model names at their real longest (`Qwen-Image-2.1-Uncensored-Q4_K_M.gguf`).
- Error messages of several sentences, in a toast and inline.
- Empty states for every list.
- German and Japanese strings (i18n landed in Workstream U) — German runs ~35 % longer than
  English and will break any row that fits English exactly. Add a pseudo-locale that pads
  every string by 40 % and run the sweep against it.

---

## 8. Pointer, touch, and zoom

- Touch targets ≥ 44 × 44 CSS px at ≤ 1023 px; ≥ 32 × 32 above. Hover-only affordances
  (the Library card actions currently appear on hover) need a touch equivalent — a visible
  control or a long-press — or they do not exist on a touch device.
- Nothing may depend on hover to be discoverable.
- 200 % zoom at 1440 must remain fully usable with no loss of function (WCAG 1.4.4).
- `prefers-reduced-motion` respected across the responsive transitions too, not just the
  existing animations.

---

## 9. Theme × breakpoint

Run the whole sweep in light and dark. Dark mode has different border and shadow tokens and
can reveal seams that light mode hides. Include the pre-paint theme script: navigate with
`?theme=dark` at each breakpoint and confirm no light flash on first paint.

---

## 10. Locking it in

- **`e2e/audit/sweep.spec.ts` becomes a blocking CI job.** It is the only thing that stops
  regression; without it this work decays within a month.
- **Visual regression snapshots** per `mode × theme × breakpoint`, masked for timestamps,
  seeds, and image content.
- **A lint rule or unit test** that flags `shrink-0` on a container with more than N children,
  and flags flex children containing text without `min-w-0`. Cheap, and it catches the two
  root causes at authoring time.
- **Component tests** (`TEST-BRIEF.md` Tier 6) assert the collapse behaviour: at a simulated
  narrow width, `<ActionBar>` renders the overflow menu and every action remains reachable
  through it.
- Update `docs/responsive.md` and `docs/quality-gates.md` — gate 7 ("every mode documented
  with a screenshot") should take its screenshots from this sweep, which kills the
  `TODO(screenshot)` placeholders at the same time.

---

## 11. Definition of done

1. `e2e/audit/sweep.spec.ts` reports **zero** across all categories for every
   width × mode × theme × state × overlay cell, and it blocks CI.
2. **Every one of the ten Stage actions is reachable at 1024**, and Delete is behind a
   deliberate affordance rather than an accidental one.
3. No element in the app has `scrollWidth > clientWidth` without a visible, keyboard-reachable
   scroll affordance.
4. No two interactive elements overlap at any tested width.
5. Every truncated string exposes its full value accessibly.
6. The phone-range decision is documented, implemented, and tested.
7. 200 % zoom at 1440 is fully usable.
8. The pseudo-locale (+40 % string length) sweep passes.
9. `docs/responsive.md` records the breakpoint contract and a per-component status table.
10. Visual regression snapshots exist for every mode × theme × breakpoint and are reviewed.

---

## 12. First session

1. Reproduce §1. With the dev server on :3001, set the viewport to 1440 × 900 in Image mode
   with a render selected, and confirm the action bar spans 679 → 1569 and that Save, Open,
   and Delete sit past the right edge. Then 1280 and 1024. **See it before you fix it.**
2. Build the detector (§4) and run it as a one-off across the 14 widths in all six modes.
   Commit the resulting `report.json` as the **baseline** — that is the ground truth for how
   much is actually broken, and every later run is measured against it.
3. Build the three primitives in §2 (`ActionBar`, `TruncatedText`, `ScrollStrip`).
4. Fix Tier A (§5 items 1–4) and re-run. Report the before/after counts from `report.json`.
5. Only then work down Tier B and C, re-running the sweep after each component.

Do not start at item 3. The baseline report in item 2 is what tells you — and the user —
whether this work is converging.

