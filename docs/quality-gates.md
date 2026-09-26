# Quality gates for 1.0

The build brief's (§Y) definition of ready, restated as a checkable list. Statuses are
honest as of **2026-09-26**; update this page whenever a gate moves. A 1.0 tag requires
every row green. Release process: [RELEASING.md](../RELEASING.md).

| # | Gate | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | `pnpm verify` green | **MET** | Measured 2026-09-26 from the working tree: typecheck, lint, 212 unit tests in 20 files, production build — exit 0. Enforced on every push and PR by `.github/workflows/verify.yml`. |
| 2 | Unit coverage ≥ 70 % on `lib/` | **UNKNOWN** | Coverage is not yet measured — vitest runs without a coverage reporter. Add `--coverage` (v8) and a threshold to make this checkable. |
| 3 | e2e covering all five (then seven) modes | **NOT STARTED** | No Playwright dependency, config, or specs in the repo. Planned in brief Workstream B (e2e slice). |
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
