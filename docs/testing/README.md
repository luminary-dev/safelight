# Testing Safelight

Everything in the default run is
hermetic: no network, no keys, no ComfyUI/Ollama, no leftover state, and never the user's
`data/`, `inputs/`, or `outputs/`.

## Running

```sh
pnpm --dir web test                # all unit tiers (~1400 tests, seconds)
pnpm --dir web coverage           # + v8 coverage with ratcheting thresholds
./web/node_modules/.bin/vitest run --project api        # one tier alone
#   projects: unit · db · api · agent · subsystems · component (jsdom)
pnpm --dir web e2e                 # 16 Playwright tests on an isolated :3005 instance
pnpm verify                        # the gate CI runs: typegen+tsc · lint · coverage ·
                                   # quality-gates drift check · build
```

## The harness (`web/src/test/`)

In-process fakes with self-tests showing usage: `fakes/comfy-server` (HTTP + RFC 6455
progress socket, scriptable failures, restart-with-counter-reset), `fakes/ollama-server`
(NDJSON, mid-stream errors, truncation), `msw/providers` (recorded wire fixtures for every
cloud provider), `fakes/search-server`, `fakes/hf-civitai` (+ a scriptable file server for
downloads), `fakes/mcp-server` (stdio + HTTP misbehavers). Fixtures: `fixtures/tmpdir`
(SAFELIGHT_*-wired sandbox with a stray-write guard), `fixtures/db` (fresh migrated DB),
`factories/`, `determinism.ts` (frozen clock, seeded random, sequential uuids),
`matchers.ts` (toBeWithinDirectory, toMatchGraphShape, toHaveStatusAndJson,
toEmitAgentEvents, toHaveContrastRatio).

## Rules (enforced by review)

Hermetic or it doesn't merge · deterministic or deleted · behavior, not implementation ·
one reason to fail · every bug fix ships its failing test · no markup snapshots · never
point a test at :3001/:8188 or read `data/keys.json`.

## Quarantine

A test failing twice in a week without a code change moves to nightly within 24 h and is
fixed or deleted within a week. **Current quarantine list: empty.**

## Known deliberate gaps

Pinned by FINDING tests rather than hidden: no download resume (a test fails the day it
lands), truncated-DB raw error, newer-version DBs opened silently, code-session roots
(absolute machine paths) appear in exports, MCP tool schemas unvalidated at connect,
single-layer (write-time) log redaction, Gemini plain-chat streams take no AbortSignal.
Still open: visual regression, an axe accessibility audit, perf/load/soak, chaos, and
packaging tests. (Test-file comments citing "TEST-BRIEF §…" refer to the internal QA brief
this suite was built from — retired to git history once executed.)
