# Quality gates for 1.0

The 1.0 definition of ready, restated as a checkable list. Statuses are
honest as of **2026-09-26**; update this page whenever a gate moves. A 1.0 tag requires
every row green. Release process: [RELEASING.md](../RELEASING.md).

| # | Gate | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | `pnpm verify` green | **MET** | Measured 2026-09-26 from the working tree: typecheck, lint, **1452 unit tests in 148 files** (plus 16 e2e), coverage thresholds, production build — exit 0. Enforced on every push and PR by `.github/workflows/verify.yml`, and `scripts/check-gates.mjs` fails verify when this table's measured numbers drift from a fresh run. |
| 2 | Unit coverage ≥ 70 % on `lib/` | **MET** | Exceeded on a much wider bar: coverage is measured over the FULL shipped surface (`src/**` — routes, components, middleware; (see docs/testing/README.md), not `lib/` alone. Measured 2026-09-26 after phases 0–6: **77.84 % lines**, 74.56 % statements, 65.44 % functions, 65.28 % branches. Ratcheting floors enforced in `web/vitest.config.ts` (75/72/62/63) gate every `pnpm verify`; §20 targets are the next climb (80 % lines / 75 % branches overall, 100 % on security boundaries). |
| 3 | e2e covering all five (then seven) modes | **PARTIAL** | 16 Playwright tests (`web/e2e/`, chromium, ~24 s, passed twice consecutively 2026-09-26 via `pnpm --dir web e2e`): boot + honest status pill with ComfyUI/Ollama down, nav + `?mode=` deep links into all six modes' landmarks, server-backed chat session create/rename/delete (survives reload), settings spend-limit persistence + Local-only badge, Escape/focus-return a11y smoke on Keys/MCP/Model-manager dialogs, Library empty state, Blueprints catalog (>100 workflows, honest "Unknown" chips offline). Runs against a throwaway data dir with both backends unreachable (`web/e2e/dev-server.mjs`); non-blocking `e2e` job in `verify.yml`. Deliberately not covered yet: real render paths, chat/agent runs (need models), MCP/key round-trips against live providers. |
| 4 | Clean install → first render on macOS, Windows, and Linux, from the signed installer | **PARTIAL** | macOS: `desktop/` Tauri shell builds Safelight.app + a DMG (2026-09-26, verified: attach to a running server, isolated spawn with its own data dir, clean shutdown; installed to /Applications). **Unsigned** — no Developer ID or notarisation; requires system Node 22+ (sidecar pending); Windows/Linux not built; first render through the installed app not yet exercised on a clean machine. |
| 5 | Data migration from every prior schema version, tested | **PARTIAL** | Numbered append-only migration runner exists (`web/src/lib/db/index.ts`, recorded in `schema_migrations`), and the pre-SQLite `sessions.json`/`themes` import is unit-tested (`lib/db/sessions.test.ts`). Missing: an automated test that opens a real `data/` fixture from each released schema version — there are no tagged releases yet, so the fixture set starts at the first tag. |
| 6 | No unauthenticated route exposes the filesystem or spends money | **PARTIAL** | In place: host allowlist + cross-origin rejection on all `/api/*` (`middleware.ts`), `/api/code/browse` confined to home + rate-limited, realpath workspace confinement, `safeJoin` on image routes, SSRF-guarded fetches. Missing: any local process can still call routes that spend cloud provider money — local auth and spend limits (Workstreams P, N) are not built. |
| 7 | Every mode documented with a screenshot | **PARTIAL** | All five modes have a docs page (`docs/modes/`), but every screenshot is still a `TODO(screenshot)` placeholder, as is the README's. |
| 8 | 48-hour soak: 500 renders, 200 agent runs, no leak, no corruption, no orphaned processes | **NOT STARTED** | No soak harness exists and no soak has been run. |
| 9 | Accessibility audit passed at WCAG AA | **PARTIAL** | Workstream T landed (`070ead3`): global focus-visible ring, dialog focus trap/return, live regions, keyboard compare slider, reduced-motion sweep, and `web/src/lib/theme/palette.test.ts` asserting the core token pairs meet AA in both themes — with one documented shortfall (light lime `#5a9e08` on paper ≈ 3.1:1, awaiting a design decision). Missing: an axe-core audit across every screen and a full keyboard/screen-reader pass (see docs/testing/README.md). |
| 10 | Cost ledger reconciles against real provider invoices within 5 % | **PARTIAL** | The ledger is live (Workstreams G+N): every cloud call writes a `usage_events` row, `lib/usage/pricing.ts` maintains per-model rates (unknown models flagged unpriced, never guessed), `/api/usage` aggregates, and spend limits enforce day/month caps globally and per provider. Missing: reconciliation against a real invoice — no billable usage has accrued yet to compare. |

## How to move a row

- State-changing work should update this table in the same PR.
- "MET" requires evidence reproducible from the repo (a command, a CI run, a test file) —
  not a recollection.
- Gates 3 and 7 widen when Video and Audio modes land (brief Workstream K): "all modes"
  means all shipped modes at the time of the 1.0 tag.
