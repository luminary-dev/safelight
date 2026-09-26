# Changelog

All notable changes to Safelight are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com); versions follow SemVer once releases begin.

## [Unreleased]

### Changed
- Performance (Workstream O, core): the 936-line Safelight component split into focused
  hooks — sessions store, image studio, backends — plus a pure, tested status derivation;
  the sidebar and every workspace are memoized with stable callbacks, so a keystroke in the
  composer or a health poll no longer re-renders the whole shell. Behavior unchanged.

### Added
- Docker deployment (Workstream Q): a multi-stage web image (standalone Next, non-root,
  /data volume — built and smoke-tested: health, sessions DB, host-allowlist 403 all
  verified in-container) and a GPL-safe compose stack where the user's local ComfyUI clone
  is bind-mounted, never baked into an image, plus Ollama, healthchecks, `.env.example`
  covering every env the code reads, `docs/deploy.md`, and a concrete Tauri 2 desktop plan
  in `docs/desktop-plan.md`. Also fixes a placeholder in pnpm-workspace.yaml that broke
  fresh installs.
- Agent runtime (Workstream G, round two): per-session sampling params (temperature, top-p,
  max tokens) honored by every provider; per-project memory the agent reads and appends —
  explicit, user-visible notes at `/api/notes`, never silent; code and design agents can
  `delegate_task` to a studio sub-agent (depth 1) whose renders stream live into the parent
  conversation; cloud image renders now price on the raw model id.
- Providers (Workstream E, round two): Mistral, DeepSeek, xAI (Grok), and Together join
  through one generic OpenAI-compatible adapter — key validation, live model catalogs,
  streaming chat, agent tool calling, and custom base URLs. Nine providers total, and the
  pricing table covers their common models so the cost ledger keeps working.
- Image pipeline depth (Workstream J): every render — local and cloud — now writes a JSON
  metadata sidecar beside its image, powering one-click Recreate and Vary on the Stage; new
  Upscale 4× (ESRGAN) and Remove background (BiRefNet) actions gated honestly on what the
  render engine actually has installed; and the queue gains per-job Cancel, Run next
  (promoted to the front under the same id), and Clear queued.
- Library (Workstream L): rebuilt as a real asset manager — outputs indexed into SQLite with
  FTS5 prompt search, model/tag/favorite/date filters with facet counts, index-time webp
  thumbnails, a hand-rolled virtualized grid, a metadata inspector fed by render sidecars, a
  compare slider, perceptual-hash duplicate detection, and bulk export/delete with home-
  confined destinations.
- Blueprints (Workstream K): all 116 workflow templates the vendored render engine ships are
  parsed into runnable capabilities — classified inputs (prompts, media slots, salient
  numerics), honest ready/missing gating against installed nodes and models (24 ready on this
  machine today), and a new Blueprints section in the sidebar with a searchable catalog and a
  generic run form. Video, audio, and 3D workflows appear with exactly what they still need.
- Local only switch (Workstream V): one toggle in Settings hard-disables every outbound
  call — cloud chat and images, web search, page fetches, model downloads, key validation,
  and remote MCP servers — while local renders, Ollama, and loopback targets keep working.
  A visible sidebar badge shows when it is on, and every blocked attempt is written to the
  audit log with the feature name, never the content.
- Release engineering (Workstreams W, X, Y): ADR 0003 proposes the business model — a
  one-time license with a signed offline license file (PROPOSED, awaiting the owner's
  sign-off; nothing is built) — RELEASING.md documents the semver/checklist/tag/rollback
  path, a tag-triggered workflow re-verifies and publishes a GitHub Release from the matching
  CHANGELOG section, and docs/quality-gates.md restates the 1.0 bar with honest statuses.
  Docs caught up with OpenRouter/Groq, the MCP client, theme apply/export, and run_command.
- Runtime observability (Workstreams G + N): agent runs persist with their full event history
  (`GET /api/runs`, capped at 200, restore-ready), every cloud provider call lands in a cost
  ledger with a maintained pricing table (`GET /api/usage` — by day, provider, mode; unpriced
  models flagged), daily/monthly spend limits warn softly and hard-stop a run mid-loop, server
  logs are structured and secret-redacted in `data/logs/`, and `/api/health` now reports
  Ollama resident models, disk free, and per-provider reachability. Local models never count
  toward spend.
- Settings (Workstream R): a gear icon opens one surface for everything — provider keys and
  MCP shortcuts, saved themes with apply/reset, daily and monthly spend limits (soft warning,
  hard stop), a 30-day usage summary, and export/import of all app data. The model manager
  gets its own sidebar button.
- Model manager (Workstream J): browse and download models from Hugging Face and Civitai
  in-app — live progress, sha256 verification when the source publishes hashes, a disk-space
  check with 2 GB headroom, cancel, and automatic placement into the correct `~/models`
  subfolder, plus curated starter picks with plain-language descriptions.
- MCP client (Workstream G): add Model Context Protocol servers (stdio or HTTP) from the new
  plug icon in the sidebar and their tools join Chat, Code, and Design as
  `mcp__<server>__<tool>`. Stdio servers run with a scrubbed environment; tools the server
  does not mark read-only show an Allow / Deny card in the conversation before every call.
  Dead servers are skipped, connections are pooled and reaped after five minutes idle.
- Design themes (Workstream I): saved themes now enforce WCAG AA contrast at save time
  (failing pairs are rejected with their ratios named), can be applied live from the swatch
  card — persisted, restored on boot, with a Reset control — and export as CSS variables, a
  Tailwind v4 `@theme` block, or DTCG design-tokens JSON.
- Providers (Workstream E): OpenRouter and Groq join as chat providers — full model catalogs
  in the picker (OpenRouter labels straight from its API, Groq via friendly names), streaming
  chat and agent-mode tool calling over the OpenAI-compatible wire format, key validation on
  save, and per-provider base-URL overrides.
- Documentation matches the product (Workstream S): root README rewritten around all five
  modes with a capability matrix and verified setup and data-layout details, web/README
  refreshed, repo-level AGENTS.md conventions, and a docs/ set covering getting started, each
  mode, providers & keys, agents & tools, privacy & security, troubleshooting, and
  architecture.
- Agent runtime v2 (Workstream G, scoped): a turn's tool calls now execute in parallel,
  transient provider failures (429/5xx) retry with backoff and a visible status, and the hard
  8-round cap became a configurable budget (24 default; 60 for coding runs, 32 for design)
  that announces when it is reached.
- Code mode (Workstream H): grep (regex, binary- and size-aware), glob, atomic multi_edit,
  delete_file, move_file — all inside the workspace approval model — and run_command, which
  executes one shell command in the workspace only after the user approves that exact command,
  with a scrubbed child environment, timeout, and captured exit/stdout/stderr.
- Chat (Workstream M): assistant replies render as markdown (GFM tables, syntax-highlighted
  code blocks with hover copy buttons, both themes), a Regenerate action on the last reply,
  and approval cards that read correctly for commands; the system prompt now invites markdown.
- Security hardening (Workstream P): Host allowlist and cross-origin rejection on every API
  route (DNS-rebinding and CSRF defense), `/api/code/browse` confined to the home subtree
  (`SAFELIGHT_BROWSE_ROOTS` to extend) with a SQLite-backed rate limit, a DNS-resolving SSRF
  guard with per-redirect re-checks for the design agent's fetches, symlink-aware
  (realpath) workspace confinement in the code tools, a Content-Security-Policy, and a
  dependency audit step in CI.
- Key vault (Workstream D): provider keys are encrypted at rest with AES-256-GCM under a key
  held in the macOS Keychain (env `SAFELIGHT_VAULT_KEY` or a mode-600 key file elsewhere).
  A plaintext `keys.json` migrates automatically and is kept as `keys.json.migrated` — rotate
  your keys, then delete it. Keys are validated with one cheap authenticated call on save, and
  each provider accepts a custom base URL for Azure/vLLM/LiteLLM-style gateways.
- SQLite data layer (`data/safelight.db`, WAL): migrations, a one-shot importer for the old
  `sessions.json` and `data/themes/*.json` (originals kept as `*.migrated`), daily local
  backups via `VACUUM INTO` (newest 7 kept), and `/api/export` / `/api/import` for full data
  portability. The repositories keep the old store's signatures, so no route changed.
  (Workstream C)
- Verification gate: `pnpm verify` (typecheck, lint, 94 unit tests, production build) and a
  GitHub Actions workflow running it on every push and PR. (Workstream B)
- Safelight mark as the favicon and sidebar logo, replacing the placeholder H2O icon.
- LICENSE (Business Source License 1.1), SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md,
  and architecture decision records under `docs/adr/`. (Workstream A)

### Changed
- Identity rename completed: components, libraries, localStorage keys (`studio.*` →
  `safelight.*` with a read-old-write-new migration shim), env vars (`SAFELIGHT_SESSIONS_FILE`
  / `SAFELIGHT_KEYS_FILE` preferred, old names still accepted), client ids, and new render
  and upload folders (`outputs/safelight/`, `inputs/safelight/` — files under the old
  `studio/` subfolders remain readable). (Workstream A)
- The stale duplicate mode toggle in the old header component was removed with the component;
  the left rail is the only mode switcher.

### Fixed
- Ollama models that report the `tools` capability are now tagged with it, so tool-capable
  local models appear in the Code and Design model pickers (found during the docs
  verification pass).
- The key vault no longer rotates the keychain entry on a transient read failure; adds are
  non-destructive and a stuck-but-present entry fails loudly instead of orphaning the
  encrypted key store.
- `safeJoin` refused legitimate folder names beginning with `..` (e.g. `..a`) because it
  matched `..` as a string prefix rather than a path segment. Found by the new test suite.

## Pre-changelog history

The prototype phase (initial commit through Design mode) predates this changelog; see
`git log` for the narrative.
