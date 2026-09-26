# Quality gates for 1.0

The build brief's (§Y) definition of ready, restated as a checkable list. Statuses are
honest as of **2026-09-26**; update this page whenever a gate moves. A 1.0 tag requires
every row green. Release process: [RELEASING.md](../RELEASING.md).

| # | Gate | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | `pnpm verify` green | **MET** | Measured 2026-09-26 from the working tree: typecheck, lint, 212 unit tests in 20 files, production build — exit 0. Enforced on every push and PR by `.github/workflows/verify.yml`. |
| 2 | Unit coverage ≥ 70 % on `lib/` | **MET** | Measured 2026-09-26 via `pnpm --dir web coverage` (v8, `src/lib/**` minus tests/fixtures/type-only files): **75.45 % lines**, 72.76 % statements, 73.17 % functions, 64.21 % branches. Enforced thresholds in `web/vitest.config.ts`: lines 70 (the brief's bar), statements 70 / functions 71 / branches 62 as floor(measured)−2 regression floors. Enforced in `pnpm verify` (and therefore CI): the verify test step runs with coverage thresholds. |
| 3 | e2e covering all five (then seven) modes | **PARTIAL** | 16 Playwright tests (`web/e2e/`, chromium, ~24 s, passed twice consecutively 2026-09-26 via `pnpm --dir web e2e`): boot + honest status pill with ComfyUI/Ollama down, nav + `?mode=` deep links into all six modes' landmarks, server-backed chat session create/rename/delete (survives reload), settings spend-limit persistence + Local-only badge, Escape/focus-return a11y smoke on Keys/MCP/Model-manager dialogs, Library empty state, Blueprints catalog (>100 workflows, honest "Unknown" chips offline). Runs against a throwaway data dir with both backends unreachable (`web/e2e/dev-server.mjs`); non-blocking `e2e` job in `verify.yml`. Deliberately not covered yet: real render paths, chat/agent runs (need models), MCP/key round-trips against live providers. |
| 4 | Clean install → first render on macOS, Windows, and Linux, from the signed installer | **NOT STARTED** | No installer exists — the app is not packaged (Workstream Q open); no signing certificates. Source install → first render works on the macOS dev machine only. |
| 5 | Data migration from every prior schema version, tested | **PARTIAL** | Numbered append-only migration runner exists (`web/src/lib/db/index.ts`, recorded in `schema_migrations`), and the pre-SQLite `sessions.json`/`themes` import is unit-tested (`lib/db/sessions.test.ts`). Missing: an automated test that opens a real `data/` fixture from each released schema version — there are no tagged releases yet, so the fixture set starts at the first tag. |
| 6 | No unauthenticated route exposes the filesystem or spends money | **PARTIAL** | In place: host allowlist + cross-origin rejection on all `/api/*` (`middleware.ts`), `/api/code/browse` confined to home + rate-limited, realpath workspace confinement, `safeJoin` on image routes, SSRF-guarded fetches. Missing: any local process can still call routes that spend cloud provider money — local auth and spend limits (Workstreams P, N) are not built. |
| 7 | Every mode documented with a screenshot | **PARTIAL** | All five modes have a docs page (`docs/modes/`), but every screenshot is still a `TODO(screenshot)` placeholder, as is the README's. |
| 8 | 48-hour soak: 500 renders, 200 agent runs, no leak, no corruption, no orphaned processes | **NOT STARTED** | No soak harness exists and no soak has been run. |
| 9 | Accessibility audit passed at WCAG AA | **NOT STARTED** | Workstream T not begun; no audit run. (Saved Design-mode themes are AA-gated server-side, but that gates user artifacts, not Safelight's own UI.) |
| 10 | Cost ledger reconciles against real provider invoices within 5 % | **NOT STARTED** | The `usage_events` table exists in the schema but nothing writes to it; there is no pricing table and no usage UI (Workstream N). Reconciliation cannot be attempted yet. |

## How to move a row

- State-changing work should update this table in the same PR.
- "MET" requires evidence reproducible from the repo (a command, a CI run, a test file) —
  not a recollection.
- Gates 3 and 7 widen when Video and Audio modes land (brief Workstream K): "all modes"
  means all shipped modes at the time of the 1.0 tag.
