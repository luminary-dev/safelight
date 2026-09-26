# Traceability — features → tests

A feature with no row does not ship. Workstream letters refer to the internal build brief (retired to git history once executed).

| Feature / workstream | Covered by |
|---|---|
| A/B/C identity, verify gate, SQLite + migrations, export/import | `lib/db/index.test.ts` (golden schema), `lib/db/sessions.test.ts`, `api/export/export-import.test.ts`, CI verify |
| D key vault + keychain | `lib/secrets/vault.test.ts` (16) |
| E providers (11) | `lib/providers/*.test.ts` incl. `parity.test.ts`, `api/keys/route.test.ts`, `api/chat/models/route.test.ts` |
| F search chain + cache | `lib/search/*`, `lib/agent/design-tools.test.ts` (chain failover, cache-no-wire) |
| G runtime: loop, retries, detached runs, sub-agents, notes, MCP | `lib/agent/run.test.ts`, `run-registry.test.ts`, `subagent.test.ts`, `project-notes.test.ts`, `mcp.test.ts`, `api/runs/runs-api.test.ts`, streaming-route framing tests |
| H code toolset + approvals | `lib/agent/code-tools.test.ts` (79 incl. escape suite), `lib/agent/approvals.test.ts`, `api/code/*.test.ts` |
| I themes: contrast gate, apply, export | `lib/theme/*` (incl. `apply.dom.test.ts`, export re-import), `api/themes/themes-api.test.ts` |
| J image depth: sidecars, actions, sweeps, prompts, memory guard, model manager | `lib/sidecars.test.ts`, `generate-core.*.test.ts`, `lib/prompts.test.ts`, `api/generate/route.test.ts`, `lib/models/*` + `api/models/*` |
| K blueprints | `lib/blueprints/*` (116-file sweep, registry, gating), `api/blueprints/blueprints-api.test.ts`, e2e catalog |
| L library | `lib/library/*` (indexer scale, dhash, confine, thumbs), `api/library/*.test.ts`, `api/gallery/route.test.ts`, library component suites |
| M chat parity | `ChatMode.test.tsx` (13), `lib/attachments.test.ts`, `api/chat/*` |
| N observability, cost, limits | `lib/log.test.ts`, `lib/usage/*` incl. `invoice.test.ts` (gate 10 fixture), `api/usage`, `api/logs` |
| O hooks/perf split | `hooks/*.test.tsx`, `lib/system-status.test.ts` |
| P/security: middleware, SSRF, traversal, rate limit | `middleware.test.ts`, `design-tools` guard matrices, traversal suites on view/gallery/library/browse, `lib/db/rate-limit.test.ts`, gitleaks in CI |
| Q packaging | Docker verified manually (deploy.md); desktop supervisor verified live — Tier 13 automation open |
| R settings | `api/settings/route.test.ts`, `SettingsDialog.test.tsx` |
| T accessibility | `lib/theme/palette.test.ts`, dialog focus e2e, component aria assertions — axe audit open (Tier 9) |
| U i18n | `i18n/catalog.test.ts` (bidirectional), `lib/i18n-format.test.ts` (de/ar) |
| V privacy | `lib/privacy.test.ts` — THE ABSOLUTE (fetch-intercepting no-outbound proof) |
| Modes e2e | `web/e2e/*` (16, blocking in CI) |
