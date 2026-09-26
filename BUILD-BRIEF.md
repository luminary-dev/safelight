# Safelight — Build Brief

**Hand this entire file to the agent as its opening prompt.** It is self-contained: it
describes what Safelight is today (verified against the code on 2026-09-26), what it must
become, and the twenty-six workstreams (A–Z) that get it there.

---

## 0. Your role and how to work

You are the lead engineer for **Safelight**, a Luminary product. Your job is to take a
working single-machine prototype and turn it into a product someone can install, trust,
pay for, and use daily.

Rules of engagement:

1. **Read before you write.** The prototype is small (~9,500 lines of TypeScript in `web/src`)
   and coherent. Read the module you are about to change in full. Match its style: terse
   comments that explain *why*, named exports, no default exports, `server-only` on anything
   that touches disk or keys, Tailwind utility classes with semantic tokens (never raw hex).
2. **Work in vertical slices.** Each workstream below ends in a state where the app still
   runs (`pnpm dev`) and the new capability is reachable from the UI. Never leave a mode
   half-wired.
3. **Every workstream ends with: tests, docs, and a changelog entry.** A workstream is not
   done when the code works; it is done when `pnpm verify` (see Workstream B) passes, the
   README/docs reflect reality, and `CHANGELOG.md` has a line.
4. **Ask before destructive or outward-facing steps**: deleting user data in `data/`,
   `inputs/`, `outputs/`; publishing a package; registering a domain; spending money on a
   third-party API; force-pushing.
5. **Never commit secrets.** `data/keys.json` currently holds live OpenAI, Anthropic, and
   Gemini keys. It is gitignored — keep it that way, never print key values, and never move
   keys into code, env files that get committed, or logs.
6. **Prefer sequencing over parallelism.** The order A → Z below is a dependency order.
   B (verification) and C (data layer) unblock most of the rest; do them early.
7. **When a decision is genuinely two-sided, state the options, pick one, say why, and move.**
   Do not stall waiting for approval on reversible choices.

---

## 1. What Safelight is

> A private darkroom. Image generation, chat, coding, and design research — all running
> against your own models on your own machine, with cloud models available when you want
> them, and nothing leaving the machine that you did not send.

The product promise is **privacy plus range**: local-first inference (ComfyUI for images,
Ollama for text), with OpenAI / Anthropic / Gemini as opt-in accelerants. Everything the
user makes lands in folders they own.

Positioning: a calm, opinionated, desktop-class creative studio. Not a ComfyUI graph editor,
not a chat wrapper. The competition is Draw Things, InvokeAI, Fooocus, LM Studio, and the
web chat apps — and Safelight's wedge is that it is *all of them in one shell*, with agents
that can act across modes.

---

## 2. Current state — verified inventory

### 2.1 Layout

```
safelight/
  package.json          root scripts: comfy, web, dev  (pnpm workspace root, no deps)
  scripts/comfy.sh      starts ComfyUI :8188, --output-directory outputs --input-directory inputs
  scripts/dev.sh        runs comfy.sh in background + pnpm --dir web dev
  comfyui/              vendored ComfyUI clone, 1.8 GB, gitignored, includes ComfyUI-GGUF
                        with a LOCAL PATCH (ModelQwenImage21 detection in tools/convert.py)
  web/                  Next.js 16.3.5 app on :3001 — the entire product surface
  data/                 sessions.json, keys.json (mode 600), themes/ — gitignored
  inputs/  outputs/     user photos and renders — gitignored
  comfyui.log
```

Git: 6 commits, branch `main`, clean tree. No remote configured.
Models live **outside** the repo in `~/models`, wired via `comfyui/extra_model_paths.yaml`.

### 2.2 Stack

Next.js 16.3.5 (App Router, Turbopack), React 19.2.8, Tailwind v4, shadcn/ui at
`style: radix-nova`, lucide icons, `motion` for animation, TypeScript 5, pnpm 11.5.2.
Provider SDKs: `@anthropic-ai/sdk` 0.127, `openai` 7.20, `@google/genai` 2.23.

### 2.3 The five modes

Switched from the **left rail** (`Sidebar.tsx`): Chat · Image · Code · Design · Library.
The **header** (`Header.tsx`) carries a second ToggleGroup that only offers Chat and Image —
a leftover from before Code/Design/Library existed. **This is a real inconsistency; fix it in
Workstream A.**

| Mode | Component | Backend | State |
|---|---|---|---|
| Image | `Studio.tsx` + `Composer` / `ImageControls` / `Stage` | `/api/generate` → ComfyUI or cloud | `ImageSession` (draft, jobs, currentJobId) |
| Chat | `ChatWorkspace` → `ChatMode` | `/api/chat` (stream) or `/api/agent` (NDJSON) | `ChatSession` (model, messages, agent flag) |
| Code | `CodeWorkspace` → `ChatMode` | `/api/code` (NDJSON) + `/api/code/approve` | `CodeSession` (model, messages, root, approvedPaths) |
| Design | `DesignWorkspace` → `ChatMode` | `/api/design` (NDJSON) | `DesignSession` (model, messages) |
| Library | `Library.tsx` | `/api/gallery` | none — reads `outputs/` |

`ChatMode.tsx` (652 lines) is the shared conversation engine for Chat, Code, and Design,
parameterised by `agentEndpoint`, `agentBody`, `agentLocked`, `showControls`, `onApprovePath`.
`Studio.tsx` (911 lines) is the god component holding all cross-mode state.

### 2.4 Agent runtime

`lib/agent/run.ts` — provider-neutral tool loop, `MAX_ROUNDS = 8`, adapters for OpenAI,
Anthropic, Gemini, and Ollama. Emits `AgentEvent` union: `text | tool | approval | status |
error | done`, streamed as newline-delimited JSON.

Three toolsets swap in via `ToolContext.toolset`:

- **Studio** (`lib/agent/tools.ts`): `generate_image`, `edit_image`, `list_models`,
  `list_recent_images`.
- **Code** (`lib/agent/code-tools.ts`): `list_files`, `read_file`, `edit_file`, `write_file`.
  Root-scoped; anything outside the root pauses the run and emits an `approval` event that
  the UI answers via `/api/code/approve`. Limits: 256 KB read, 512 KB write, 400 entries,
  depth 6, skips `.git`/`node_modules`/`.next`/`.venv`/`dist`/`build`. **No command execution.**
- **Design** (`lib/agent/design-tools.ts`): `search_web`, `fetch_page`, `save_theme`.

`lib/agent/approvals.ts` holds in-flight approvals in a module-level `Map` with a 180 s
timeout that resolves to deny.

### 2.5 Image pipeline

`lib/comfy/graph.ts` builds a ComfyUI graph per request. `lib/comfy/models.ts` scans
`unet_gguf`, `diffusion_models`, `checkpoints`, `text_encoders`, `clip`, `clip_gguf`, `vae`,
`loras` and classifies families by filename: `qwen-image | flux | sdxl | sd15 | unknown`.
`lib/studio-state.ts` `defaultsForModel()` gives each family sane steps/cfg/sampler/scheduler
and picks compatible text encoders + VAE.

`lib/generate-core.ts`: `sanitizeRequest` (clamps every numeric), `queueLocal` (calls
`unloadOllamaModels()` first to free unified memory, then `queuePrompt`), `runCloud`
(OpenAI/Gemini images → `outputs/cloud/`), `jobStatus`, `waitForJob`.

Live progress: `hooks/useComfySocket.ts` holds a WebSocket to ComfyUI keyed by a stable
`clientId` in localStorage, so a page reload still sees progress on an in-flight job.

Measured on the dev machine (26 GB Mac, Qwen-Image 2.1 Q4_K_M): **~23–27 s per step at
1024 px, ~11 minutes for a 25-step render.** This number drives most of the UX decisions.

### 2.6 Persistence

`data/sessions.json` — one file, `{ sessions: [], projects: [] }`. `lib/sessions-store.ts`
serialises every read-modify-write through a promise queue and writes atomically via
tmp-file + rename. Client owns UUIDs. Client-side settings live in localStorage under keys
still prefixed `studio.*`.

`data/keys.json` — mode 600, plaintext JSON, read on every request. Env vars
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` are the fallback.

### 2.7 Design language

`app/globals.css` (403 lines). "Soft & calm": `--paper: #f7f7f5`, white cards, gray text ramp,
lime accent (`--primary: #84cc16`, text-safe `--terracotta: #5a9e08`). Dark mode is a zinc
companion with the lime brightened. Type: Outfit everywhere, JetBrains Mono for captions and
counts. Radii 16–24 px, pill buttons, whisper shadows. Theme applied pre-paint by an inline
script in `layout.tsx`. Deep links: `?mode=`, `?systems=1`, `?picker=1`, `?theme=`.

### 2.8 What is missing — the honest list

These are the gaps that stand between "impressive prototype" and "product". Every one is
addressed by a workstream below.

1. **No tests. No CI. No typecheck gate.** `package.json` has `dev`, `build`, `start`, `lint`.
   Types and the production build are in fact clean today (verified 2026-09-26) — but nothing
   enforces that they stay clean.
2. **No production path.** `next build` works, but nothing consumes its output: no `start`
   in the run scripts, no Docker, no desktop bundle, no installer, no auto-update. Setup is a manual `git clone` of ComfyUI plus
   a `uv venv` — unshippable to a non-developer.
3. **JSON-file datastore.** Single process only, no migrations, no backup, no query, no
   integrity. Will corrupt or lose data eventually.
4. **Plaintext API keys on disk.** Mode 600 is not enough for a product.
5. **No auth and no origin checks.** `/api/code/browse` will enumerate **any directory on the
   machine** for anyone who can reach `:3001`. Every mutating route accepts any origin. Safe
   only because Next binds to localhost by default — one `-H 0.0.0.0` away from a breach.
6. **SSRF guard is string-based.** `design-tools.ts` `guardUrl()` blocks private hostnames by
   regex but never resolves DNS, so a hostname pointing at 127.0.0.1 passes.
7. **Web search is DuckDuckGo HTML scraping** with a regex over `result__a`. No API key, no
   rate limit handling, no caching — it will break.
8. **Design themes are a dead end.** `save_theme` writes `data/themes/*.json` and renders a
   swatch card. Nothing ever applies, exports, or reuses them.
9. **Docs drift badly.** Root `README.md` documents only Chat and Image — Code, Design,
   Library, projects, and themes are undocumented. `web/README.md` still says "Studio web".
   The README itself admits the folder rename is incomplete. localStorage keys are `studio.*`.
   The favicon is `public/h2o-cube.svg` — **H2O branding inside a Luminary product.**
10. **The ComfyUI capability is 95% unexposed.** `comfyui/blueprints/` ships ~90 workflows —
    LTX-2.5 and Wan 2.2 video, SAM3 segmentation, MoGe/Marigold depth, TripoSplat 3D,
    Stable Audio and YuE2 music, upscaling, frame interpolation, inpainting, outpainting,
    ControlNet, pose. Safelight exposes txt2img and img2img and nothing else.
11. **No model manager.** Users must hand-place files into `~/models`.
12. **No observability, no cost tracking, no usage limits** on cloud calls.
13. **No MCP client**, no plugin surface, no export/import, no keyboard-first command palette
    beyond ⌘K search, no mobile or accessibility pass.

---

## 3. Target architecture

Keep the shape; harden the layers.

```
┌─ Desktop shell (Tauri) ─────────────────────────────────────────────┐
│  supervises: Next.js server · ComfyUI (Python) · Ollama (optional)  │
│  owns: auto-update, OS keychain, file dialogs, notifications        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌─ web/ (Next.js) ─────────────┴──────────────────────────────────────┐
│  app/           routes + API                                        │
│  components/    5 mode workspaces over one shell                    │
│  lib/                                                               │
│    agent/       runtime · toolsets (studio, code, design, mcp)      │
│    providers/   openai · anthropic · gemini · ollama · openrouter   │
│                 · groq · mistral · fal · replicate · elevenlabs     │
│    search/      brave · tavily · exa · serper · ddg(fallback)       │
│    comfy/       client · graph builder · model catalog · blueprints │
│    db/          SQLite schema · migrations · repositories           │
│    secrets/     keychain-backed vault                               │
│    telemetry/   logs · traces · cost ledger                         │
└─────────────────────────────────────────────────────────────────────┘
```

**Rules:** the UI never talks to a provider directly — always through a route. Every route
that mutates state or spends money checks origin and rate limit. Every provider implements
one interface so adding the next one is a file, not a refactor.

---

## 4. Workstreams A–Z

Each has a **Goal**, **Do**, and **Done when**. Ship them in order unless noted.

---

### A. Identity, naming, and the rename

**Goal:** the product is called Safelight everywhere, and Luminary owns the branding.

**Do:**
- Stop the running services, then finish the `studio/` → `safelight/` rename the README admits
  is pending. Grep for `studio` across `web/src`, `scripts/`, and docs.
- Migrate localStorage keys `studio.*` → `safelight.*` with a one-time read-old-write-new
  shim so existing users keep their settings. Same for `STUDIO_SESSIONS_FILE` /
  `STUDIO_KEYS_FILE` env vars (accept both, prefer `SAFELIGHT_*`).
- **Delete `public/h2o-cube.svg`.** Design a Safelight mark from `StudioMark` in `Header.tsx`
  (ink tile, paper disc, accent crescent) as a real SVG set: favicon, 512 px app icon,
  macOS `.icns`, Windows `.ico`, maskable PWA icons.
- Remove the duplicate mode ToggleGroup from `Header.tsx` — the left rail is the only mode
  switcher. The header keeps the mark, status pill, keys, and theme toggle.
- Add `LICENSE`, `CODE_OF_CONDUCT.md`, `SECURITY.md` (with a disclosure address),
  `CHANGELOG.md` (Keep a Changelog format), and `CONTRIBUTING.md`.
- Decide and record the license. If Safelight is commercial, use a source-available license
  (BSL 1.1 or Elastic 2.0) and say so in the README; if open, use Apache-2.0. **Note the
  obligation:** ComfyUI is GPL-3.0. Vendoring it into a distributed bundle has licensing
  consequences — keep ComfyUI as a separately-installed process the app supervises over HTTP,
  not a linked or redistributed component, and get this reviewed before shipping binaries.

**Done when:** no string `studio` or `h2o` survives outside `comfyui/`, the app icon is
Safelight's own, and the license question is answered in writing.

---

### B. Verification: types, lint, tests, CI

**Goal:** nothing merges that does not build, typecheck, lint, and pass tests.

**Do:**
- Add to `web/package.json`: `typecheck: tsc --noEmit`, `test: vitest run`,
  `test:watch`, `e2e: playwright test`, and a root `verify: pnpm -r typecheck && pnpm -r lint
  && pnpm -r test && pnpm --dir web build`.
- **Vitest** for units. First targets, in priority order, because they are the load-bearing
  pure functions:
  - `lib/studio-files.ts` `safeJoin` and `parseImageRef` — path traversal table tests
    (`../`, absolute, symlink, unicode dots, `foo/../../bar`).
  - `lib/generate-core.ts` `sanitizeRequest` — every clamp boundary.
  - `lib/comfy/models.ts` `classifyFamily` — a fixture list of ~60 real model filenames.
  - `lib/comfy/graph.ts` `buildGraph` — snapshot the graph JSON per family × mode.
  - `lib/studio-state.ts` `defaultsForModel`, `lib/presets.ts` `roundTo32` / `scaledSize`.
  - `lib/session-types.ts` `autoTitle`.
  - `lib/agent/code-tools.ts` `resolvePath` — inside root, outside root with approval,
    outside root denied, approved-subtree inheritance.
  - `lib/agent/design-tools.ts` `guardUrl` — the full private-address matrix.
- **MSW** to fake provider HTTP so provider adapters and the agent loop are testable without
  keys or network. Record one real fixture per provider for the streaming shape.
- **Playwright** e2e against a dev server with ComfyUI stubbed: create a session, type a
  prompt, mock the render, see it in the Stage and then in the Library; switch modes;
  create/rename/delete a project; set and clear a key.
- **GitHub Actions**: `verify` on every PR (Node 22, pnpm cache), plus a nightly job that runs
  the real-provider contract tests against recorded fixtures to detect SDK drift.
- Turn on `typescript.ignoreBuildErrors: false` and `eslint.ignoreDuringBuilds: false`
  explicitly in `next.config.ts` so nobody can disable them by accident.

**Done when:** `pnpm verify` is green from a clean checkout and CI blocks merges on it.

---

### C. Data layer: SQLite, migrations, backup

**Goal:** durable, queryable, multi-process-safe state.

**Do:**
- Introduce SQLite via `better-sqlite3` (synchronous, fastest for a local app) or `libsql`
  if you want optional remote sync later. Put the DB at `data/safelight.db`.
- Schema: `projects`, `sessions`, `messages`, `tool_calls`, `attachments`, `jobs`,
  `images` (indexed by path, mtime, prompt, model, seed), `themes`, `providers`,
  `usage_events`, `settings`, `schema_migrations`.
- Write a migration runner (plain numbered `.sql` files, applied in a transaction, recorded
  in `schema_migrations`). No ORM — the query surface is small and an ORM will fight you.
- Replace `lib/sessions-store.ts` with repository modules under `lib/db/`, keeping the exact
  same exported function signatures so the API routes do not change in this workstream.
- **Write a one-shot importer** that reads an existing `data/sessions.json` and
  `data/themes/*.json` into the DB on first run, then renames the JSON to `.migrated`.
  Test it against the real file shape.
- Nightly local backup: copy the DB with `VACUUM INTO` to `data/backups/`, keep 7.
- Add `/api/export` (full JSON dump: sessions, messages, themes, settings — no keys) and
  `/api/import`. This is the user's data-portability guarantee and it is a selling point.

**Done when:** the app runs entirely off SQLite, an old JSON install upgrades cleanly, and
export→wipe→import round-trips losslessly under test.

---

### D. Secrets and the key vault

**Goal:** API keys are never plaintext on disk and never leave the machine except to their
own provider.

**Do:**
- Replace `lib/providers/keys.ts` file storage with an OS keychain binding (macOS Keychain,
  Windows Credential Manager, libsecret) exposed by the Tauri shell (Workstream Q). Until the
  shell exists, encrypt `data/keys.json` at rest with a key derived from a user passphrase
  (argon2id) or a machine-bound key, and keep the same `getKey`/`setKey`/`keyStatuses` API.
- Never log a key, never return one over HTTP (the current code is already correct here —
  `keyStatuses` returns only a `…abcd` hint; preserve that).
- Add per-provider key **validation on save**: make one cheap authenticated call, report
  "works / wrong key / no quota" in the Keys dialog rather than failing silently at use time.
- Support **bring-your-own base URL** per provider (for Azure OpenAI, self-hosted vLLM,
  LiteLLM proxies, corporate gateways).
- Rotate the three keys currently sitting in `data/keys.json` once the vault ships — they
  have been on disk in plaintext.

**Done when:** a fresh install stores nothing sensitive in a readable file, and the Keys
dialog tells you whether each key actually works.

---

### E. Provider layer: every model worth having

**Goal:** one interface, many providers, no per-provider special cases leaking into the UI.

**Do:**
- Formalise `lib/providers/types.ts` into a `Provider` interface: `listModels`, `streamChat`,
  `generateImages?`, `generateVideo?`, `generateSpeech?`, `transcribe?`, `embed?`,
  `supportsTools`, `supportsVision`, `pricing`.
- Add adapters: **OpenRouter** (one key, hundreds of models — the highest-leverage single
  addition), **Groq** (fast inference), **Mistral**, **DeepSeek**, **xAI**, **Together**,
  **Cerebras**, **Vercel AI Gateway** (routing + fallback + spend caps in one key).
- Media providers: **fal.ai** and **Replicate** for hosted image/video when the local Mac is
  too slow; **ElevenLabs** for speech; **Deepgram** or **AssemblyAI** for transcription.
- Consider migrating the chat/tool-calling path to the **Vercel AI SDK** (`ai` package). It
  already normalises streaming, tool calls, and provider quirks across every provider above —
  it would delete most of `lib/agent/run.ts`'s four hand-written adapters. Evaluate this
  explicitly and record the decision; if you keep the hand-rolled loop, document why.
- Keep the **capability-aware model picker** that already exists (`vision`, `tools` tags) and
  extend it: cost/1k tokens, context window, speed tier, local-vs-cloud, and a
  "recommended for this mode" badge.
- **Model routing rules** the user can set: "use local for chat, cloud for images", "never
  send images to cloud", "fall back to Groq if Ollama is down".

**Done when:** adding a provider is one file plus one registry line, and the picker groups
by source with capability and cost visible.

---

### F. Web search and research — replace the scraper

**Goal:** search that works reliably, cites sources, and is available to every agent, not just
Design mode.

**Do:**
- New `lib/search/` with a `SearchProvider` interface and adapters for **Brave Search API**
  (independent index, generous free tier — make this the default), **Tavily**
  (LLM-optimised, returns clean extracts), **Exa** (semantic/neural, best for "find sites
  like this"), **Serper** or **SerpAPI** (Google proxy), and **Perplexity Sonar** (search +
  synthesis in one call). Keep the DuckDuckGo HTML scraper as an unkeyed last-resort fallback
  and mark it as such in the UI.
- Provider chain with automatic failover and a shared **response cache** (SQLite, TTL 1 h,
  keyed by normalised query) so an agent that searches the same thing twice costs once.
- Replace `fetch_page` with a real reader: try **Jina Reader** (`r.jina.ai`) or **Firecrawl**
  for JS-rendered pages, fall back to the current strip-HTML path. Keep the existing
  colour/font extraction — it is genuinely useful for Design mode — but move it to an opt-in
  `extract_design_tokens` tool.
- **Fix the SSRF guard properly:** resolve the hostname with `dns.lookup` and reject if any
  resolved address is loopback, link-local, private, CGNAT, or unique-local. Re-check after
  each redirect. Add a request timeout, a response size cap, and a deny-list for cloud
  metadata endpoints (`169.254.169.254`, `metadata.google.internal`). Unit-test every case.
- Respect `robots.txt` on fetch, send a real `User-Agent` with a contact URL, and rate-limit
  per host.
- **Promote search to a shared toolset**: `search_web`, `fetch_page`, `search_images`,
  `search_news` available to Chat agent mode and Code mode (for docs lookup), not just Design.
- Every agent answer that used search must render **inline citations** with favicon, title,
  and domain, and a sources list under the reply.

**Done when:** a Design-mode research task runs end to end with a real search API, citations
render, and the SSRF tests pass.

---

### G. Agent runtime v2

**Goal:** an agent loop that is fast, interruptible, observable, and extensible.

**Do:**
- **Parallel tool calls.** The loop is currently sequential; providers already return multiple
  tool calls per turn. Execute independent calls concurrently with a bounded pool.
- **Raise and make configurable `MAX_ROUNDS`** (currently 8 — too low for real coding work).
  Replace with a budget: max rounds, max wall-clock, max tokens, max spend. Surface remaining
  budget in the UI.
- **Retries with backoff** on 429/5xx, with a visible "retrying" status event.
- **Cancellation that actually cancels**: propagate `AbortSignal` into ComfyUI (`/interrupt`),
  into provider streams, and into in-flight tool calls.
- **Persist agent runs** to the DB (`tool_calls` table) so a reload restores a run in progress
  and you can inspect what an agent did last week.
- **Sub-agents**: let an agent spawn a scoped child run with its own toolset and budget
  (e.g. Chat mode delegating a render to the studio toolset).
- **Memory**: a per-project notes store the agent can read and append to, so long projects
  do not restart cold. Keep it explicit and user-visible — never silent.
- **MCP client support.** This is the extensibility unlock: let users add MCP servers in
  Settings (stdio and HTTP), list their tools, and expose them to any agent mode with a
  per-server allow/deny and an approval prompt for destructive tools. Safelight then inherits
  the whole MCP ecosystem — GitHub, Linear, Slack, Notion, filesystem, databases — without
  you writing a single integration.
- **Structured tool results**: keep the existing `ToolCall.result` card rendering and give
  each tool a renderer so results look designed, not like JSON.

**Done when:** a Code-mode task runs 30+ rounds with parallel reads, survives a page reload,
can be cancelled mid-tool, and an MCP server's tools appear alongside the built-ins.

---

### H. Code mode → a real coding agent

**Goal:** competitive with a terminal coding agent, inside Safelight's shell.

**Do:**
- Add tools: `grep` (ripgrep, respecting `.gitignore`), `glob`, `multi_edit` (atomic
  multi-file patch), `delete_file`, `move_file`, and — behind explicit per-command approval —
  `run_command` in a constrained shell with the workspace as cwd, a timeout, and captured
  output. Command execution is what the current empty state apologises for; it is the single
  biggest gap.
- **Git integration**: show branch and dirty state in the workspace header; `git diff` before
  the agent writes; a **diff review panel** where the user accepts or rejects each hunk before
  it lands; `git stash` as an undo. Never commit without asking.
- **Keep the approval model and make it durable.** Current approvals live in a module-level
  `Map` and die with the process. Persist approved paths to the session (already in
  `approvedPaths`) and to the DB, with a visible, revocable list (the UI for this already
  exists — wire it to real storage).
- Language intelligence: run the project's own `tsc`/`eslint`/`pytest` via `run_command` and
  feed failures back into the loop so the agent self-corrects.
- Raise `MAX_READ_BYTES` (256 KB is small for real files) and add chunked reading with a
  `totalLines` header — the read tool already returns `totalLines`, use it for paging.
- A file tree beside the conversation, with the agent's touched files highlighted.

**Done when:** the agent can be pointed at a real project, find a bug with grep, read the
file, propose a diff, run the test suite, and iterate — with the user approving writes.

---

### I. Design mode → a design system factory

**Goal:** themes stop being dead JSON and become something the user ships.

**Do:**
- **Apply a saved theme live** to Safelight itself (preview), and let the user keep it.
  This closes the loop that `save_theme` currently leaves open.
- **Export** a theme as: CSS custom properties, a Tailwind v4 `@theme` block, shadcn
  `globals.css`, design tokens (W3C DTCG JSON), a Figma Tokens file, and a Swift/Android
  colour set.
- **Contrast enforcement, not suggestion.** `DESIGN_SYSTEM_PROMPT` asks the model to "check
  contrast" — verify it in code. Compute WCAG 2.2 AA/AAA ratios for every text-on-surface
  pair server-side in `save_theme`, reject or auto-correct failures, and show the ratios on
  the swatch card.
- Expand the theme object: full colour ramps (50–950) rather than six flat colours, spacing
  and radius scales, shadow scale, and type scale with real font pairings resolved against
  Google Fonts (check availability at save time).
- **Screenshot the references.** Use a headless browser to capture the sites the agent found
  so the swatch card shows what inspired it. Gate it behind the same SSRF rules as fetch.
- Generate a **live preview page** per theme — buttons, cards, forms, a chart, dark and light —
  so the user judges a theme in situ, not as six squares.

**Done when:** a user asks for "a theme like Linear but warmer", gets swatches with verified
contrast, previews it applied to Safelight, and exports Tailwind tokens.

---

### J. Image pipeline: depth

**Goal:** everything a serious image user expects, without a node graph.

**Do:**
- **Model manager**: browse and download from Hugging Face and Civitai inside the app, with
  progress, checksum verification, disk-space check, and a "what is this for" description.
  Place files into the right `~/models` subfolder automatically. This removes the worst
  onboarding step in the product.
- **Inpainting and outpainting** with a mask brush on the Stage — `comfyui/blueprints/` already
  has `Image Inpainting (Qwen-image).json`, `Image Inpainting (Flux.1 Fill Dev).json`, and
  `Image Outpainting (Qwen-Image).json` to model the graphs on.
- **ControlNet** (canny, depth, pose) — blueprints exist for Z-Image-Turbo ControlNet, SDPose,
  Marigold/MoGe/Depth Anything 3 depth, and canny→image.
- **Upscaling** (`Video Upscale(GAN x4)`, standard ESRGAN models) as a one-click action on any
  Library image.
- **Background removal** (`Remove Background (BiRefNet)`) and **segmentation** (`SAM3`) as
  Stage actions.
- **Queue management**: a real job queue with reorder, pause, cancel, and priority — at 11
  minutes per render this matters more than anything else in the mode.
- **Metadata sidecars**: write a JSON sidecar (or PNG text chunk) beside every render with
  prompt, negative, model, LoRA, seed, sampler, scheduler, steps, cfg, dimensions, timestamp.
  Then "recreate this render" and "vary this render" become one click, and the Library becomes
  searchable by parameter.
- **Prompt library**: saved prompts, wildcards/variables, and a prompt-enhance action (the
  `Prompt Enhance.json` blueprint exists).
- **Batch/grid**: run a seed sweep or a parameter sweep and show the grid (`Crop Images 3x3`,
  `Split Image Grid to Tiles` blueprints exist).

**Done when:** a user can download a model, generate, mask-edit, upscale, and recreate an old
render from its metadata, without touching ComfyUI.

---

### K. Video, audio, and 3D — the unexposed 95%

**Goal:** surface what the vendored backend can already do.

**Do:**
- Read `comfyui/blueprints/*.json` and build a **blueprint registry**: parse each workflow,
  identify its inputs (prompt, image, video, duration, fps), and generate a Safelight form for
  it. This is the highest-leverage single piece of engineering in the whole brief — ~90
  capabilities become available from one abstraction.
- New **Video** mode: text→video (LTX-2.5, Wan 2.2), image→video, first/last-frame→video,
  video edit, frame interpolation, video upscale, video segmentation, video captioning.
- New **Audio** mode: text→music (YuE2, MiniMax Music 3), text→audio (Stable Audio 3),
  music cover, plus transcription via a cloud provider.
- **3D**: image→gaussian splat (TripoSplat), geometry/normal/depth estimation (MoGe,
  Marigold V2) with a `<model-viewer>` preview.
- Long-running job UX: these take far longer than images. Background queue, OS notification on
  completion (via the Tauri shell), and resumable progress.
- Gate each capability on whether its required models and custom nodes are present, with a
  one-click "install what this needs" that uses the model manager from J.

**Done when:** at least text→video, image→video, and text→music work end to end from a
Safelight form, and the blueprint registry drives them.

---

### L. Library: make it a real asset manager

**Goal:** thousands of files stay navigable.

**Do:**
- Index `outputs/` into the DB (path, mtime, size, dimensions, and the metadata sidecar from
  J). Watch the folder for changes rather than re-walking on every request — the current
  `/api/gallery` walks the tree and caps at 400 items.
- Search by prompt text, model, seed, date, dimensions, and tag. Full-text via SQLite FTS5.
- Favourites, tags, and collections. Filter by session and by project (the filmstrip already
  has session/all; extend it here).
- Virtualised grid, lazy thumbnails generated at index time (not full-size images scaled in
  CSS, which is what happens now).
- Compare view (two images side by side, slider), and a metadata inspector panel.
- Bulk select → export to a folder, delete, or re-run.
- Duplicate detection by perceptual hash.

**Done when:** 10,000 images scroll smoothly and "show me every Qwen render with 'linen' in
the prompt from last week" takes one query.

---

### M. Chat mode: polish to parity

**Goal:** as good as the chat app the user would otherwise open.

**Do:**
- **Markdown rendering** with syntax-highlighted code blocks, copy buttons, tables, and math.
  Currently replies render as plain text, which is why `CHAT_SYSTEM_PROMPT` has to ask the
  model to avoid markdown headings — fix the renderer and drop that instruction.
- Streaming with a stop button, regenerate, edit-and-resend, and **branching** (fork a
  conversation from any message).
- Per-session system prompt and parameters (temperature, top-p, max tokens), plus saved
  **prompt presets**.
- File attachments beyond images: PDF, text, CSV, code — extract text server-side and attach.
  (`anthropic-skills:pdf` patterns apply.)
- Voice: push-to-talk input via transcription, and optional TTS playback of replies.
- Token counting and live cost estimate per message, from the pricing table in Workstream N.
- Keep the existing "Use as image prompt" / "Use with the photo as reference" handoffs —
  they are the best cross-mode idea in the product. Extend them: "open this in Code",
  "research this in Design".

**Done when:** a long technical conversation with code, citations, and an attached PDF reads
as well as it would anywhere else.

---

### N. Observability, cost, and limits

**Goal:** know what the app is doing and what it costs.

**Do:**
- Structured logging (`pino`) with levels, redaction of keys and prompts-by-default, and a
  rotating file in `data/logs/`. A log viewer in Settings.
- Error reporting: **Sentry**, opt-in, with PII scrubbing. Default off; ask on first run.
- **Cost ledger**: a `usage_events` row for every provider call — provider, model, input
  tokens, output tokens, images, duration, computed cost from a maintained pricing table.
  A Usage page with spend by day / provider / mode / project.
- **Spend limits**: soft warning and hard stop per day and per month, per provider. An agent
  run that would exceed the limit pauses and asks.
- Local metrics: render time per step per model, so the app can give an honest ETA instead of
  a spinner — you have the data (`comfyui.log` shows 23–27 s/step) and the `Job` type already
  carries `startedAt` and `settings`.
- Health: extend the existing status pill (which is already good) with ComfyUI VRAM/RAM from
  `/system_stats`, Ollama resident models, disk free, and per-provider reachability.

**Done when:** the user can answer "what did I spend this month and on what" without leaving
the app.

---

### O. Performance and memory

**Goal:** the app feels fast on the machine it runs on, and does not thrash.

**Do:**
- **Break up `Studio.tsx` (911 lines).** Extract per-mode state into hooks or a small store
  (Zustand or `useSyncExternalStore`) so mode switches do not re-render everything. This is a
  prerequisite for O and for anything in J/K.
- Memoise the Library grid and filmstrip; virtualise both.
- The existing `unloadOllamaModels()` before a local render is a good instinct — generalise it
  into a **memory manager**: know each model's footprint, know free unified memory, warn before
  a render that will swap, and offer to unload. The README's 26 GB maths belongs in code.
- Thumbnail generation at index time (`sharp`), served from a cache directory.
- Warm-start: keep the last-used image model resident when memory allows, since the first step
  after a cold load is dramatically slower.
- Measure: add a `?perf=1` overlay showing render counts and interaction latency.

**Done when:** mode switching is instant with 200 sessions loaded, and the app warns before
it would push the machine into swap.

---

### P. Security hardening

**Goal:** safe even if the port is exposed, and safe against a hostile model.

**Do:**
- **Origin/CSRF checks on every mutating route.** Reject requests whose `Origin` is not the
  app's own. Currently every POST/PATCH/DELETE accepts any origin.
- **Lock down `/api/code/browse`.** Today it lists any directory on the machine, unauthenticated.
  Require a session, restrict to a configured set of roots, and rate-limit it.
- **Local auth**: a passcode or OS-biometric unlock on first load per device, stored as an
  httpOnly cookie. Required before the app may bind to anything but localhost.
- Rate limits per route (token bucket in SQLite): generation, agent runs, search, browse.
- **Treat model output as untrusted.** A model that has read a web page or a repo file can be
  carrying an injection. Never auto-execute a tool call that writes outside the workspace,
  spends money, or runs a command, without the existing approval prompt. Render tool
  arguments to the user before execution for the destructive ones.
- Harden the path layer: the existing `safeJoin` is correct — use it *everywhere*, add
  `realpath` checks so a symlink inside the workspace cannot escape it, and cover both with
  the tests from B.
- CSP headers, `X-Content-Type-Options`, `Referrer-Policy`, and no `dangerouslySetInnerHTML`
  outside the pre-paint theme script (which is fine and should stay).
- Dependency scanning (`pnpm audit`, Dependabot or Renovate) in CI.
- Run the repo's own `/security-review` against the diff before each release.

**Done when:** an external security pass finds nothing exploitable from an unauthenticated
request to `:3001`, and the injection path through Design/Code mode is documented and gated.

---

### Q. Packaging and distribution

**Goal:** a person who does not know what `pnpm` is can install Safelight.

**Do:**
- **Tauri 2 desktop shell.** Smaller and faster than Electron, and it gives you the OS keychain
  (D), native file dialogs (better than the current path-typing in Code mode), notifications
  (K), and auto-update. The shell supervises three child processes: the Next.js server, ComfyUI,
  and optionally Ollama — starting, health-checking, and restarting each.
- **Bundle the Python side properly.** Ship a pinned ComfyUI + ComfyUI-GGUF via `uv` into an
  app-managed venv on first run, and **carry the local `convert.py` patch as a real patch file
  applied at install time** — the README warns it must be re-applied by hand after a re-clone,
  which will silently break Qwen-Image 2.1 GGUF loading for every user who re-installs.
  Re-check whether upstream has fixed it and drop the patch if so.
- **First-run wizard**: detect hardware, recommend a model set, download it (via J's model
  manager), check Ollama, offer to install it, collect optional API keys, pick a theme.
- Signed and notarised builds: macOS (Developer ID + notarisation), Windows (Authenticode),
  Linux (AppImage + deb).
- **Docker Compose** as the server/headless path: `web`, `comfyui`, `ollama` services with
  GPU passthrough, volumes for `models`, `data`, `inputs`, `outputs`.
- Release automation: tag → CI builds all platforms → GitHub Release with notes from
  `CHANGELOG.md` → auto-update feed.

**Done when:** a download-and-double-click install produces a working Safelight with a model
on a clean machine, and it updates itself.

---

### R. Settings

**Goal:** one place for everything currently scattered across dialogs, env vars, and files.

**Do:** a Settings surface with sections — Providers & keys (D, E), Search providers (F),
MCP servers (G), Models & storage paths (J), Appearance & themes (I), Limits & spend (N),
Privacy & telemetry (V), Backups & export (C), Advanced (ports, ComfyUI args, logs).
Every setting persists to the DB, is exported by `/api/export`, and has a documented default.

---

### S. Documentation

**Goal:** docs that match the product. The current drift is the clearest signal that the
prototype outran its documentation.

**Do:**
- Rewrite the root `README.md`: what Safelight is, screenshots of all modes, install, first
  render, and a capability matrix. **It currently documents two of five modes.**
- Replace the stale `web/README.md` ("Studio web") or delete it.
- A `docs/` site (Nextra or Fumadocs): Getting started · Modes (one page each, all five, then
  Video/Audio from K) · Models · Providers & keys · Agents & tools · MCP · Privacy & security ·
  Troubleshooting · API reference · Architecture.
- `AGENTS.md` at the repo root (not only the Next.js-generated block in `web/AGENTS.md`)
  describing conventions for future agents working in this codebase.
- A short architecture decision log (`docs/adr/`) — start by recording the SQLite choice (C),
  the AI SDK decision (E), and the ComfyUI licensing stance (A).
- **Doc-drift guard in CI**: fail the build if a new mode, route, or env var is added without
  a docs reference.

---

### T. Accessibility and responsive

**Goal:** usable with a keyboard and a screen reader, and not broken on a laptop screen.

**Do:** full keyboard navigation and a visible focus ring (the `--focus-ring` token exists —
apply it consistently); ARIA roles and live regions for streaming replies and render progress;
respect `prefers-reduced-motion` (the app leans on `motion` and a plasma shader background);
verify every token pair against WCAG AA — reuse the contrast checker from I; test with
VoiceOver; responsive layouts down to 1024 px, and a genuinely usable tablet layout for the
Library and Chat.

---

### U. Internationalisation

**Goal:** the shell is translatable even if you ship English first.

**Do:** extract all UI strings to a message catalogue (`next-intl`), keep English as source,
support RTL in the layout (`components.json` already has an `rtl` flag), and localise dates,
numbers, and file sizes. Do not translate model names or prompts.

---

### V. Privacy and telemetry

**Goal:** the privacy promise is verifiable, not just marketed.

**Do:** telemetry **off by default**, opt-in with a plain-language explanation of every field;
never send prompts, images, filenames, or keys; a "Local only" master switch that hard-disables
every outbound call including search and cloud providers, with a visible indicator when it is
on; a privacy page in the docs that states exactly what leaves the machine and when; a
network-activity log the user can inspect.

---

### W. Business model

**Goal:** decide how Safelight sustains itself before the architecture forecloses the options.

**Do:** pick one and build the minimum for it —
(a) **free and open**, donations, no accounts;
(b) **one-time license** with a signed offline license file, free major-version updates for a
year (Sublime/Tower model — fits a local-first app best);
(c) **subscription** with a hosted convenience layer (managed search keys, cloud render
offload via fal/Replicate, sync between machines).
Whichever you choose, keep the local-only mode fully functional and unlicensed-usable; the
privacy promise is the product, and gating it would undermine the thing people came for.
If (b) or (c), add: Stripe checkout, license validation that works offline, an account page,
and a clear upgrade path. Record the decision in `docs/adr/`.

---

### X. Release engineering

**Goal:** shipping is boring.

**Do:** semantic versioning; Changesets or release-please for the changelog; a release branch
policy; a canary/beta channel in the auto-updater; staged rollout; a rollback plan; and a
pre-release checklist that runs `pnpm verify`, the e2e suite on all three platforms, a
migration test from the previous version's data, and `/security-review`.

---

### Y. Quality gates before 1.0

**Goal:** an explicit, checkable definition of ready.

The bar for 1.0:
- `pnpm verify` green; unit coverage ≥ 70 % on `lib/`; e2e covering all five (then seven) modes.
- Clean install → first render on macOS, Windows, and Linux, from the signed installer.
- Data migration from every prior schema version, tested.
- No unauthenticated route exposes the filesystem or spends money.
- Every mode documented with a screenshot.
- 48-hour soak: 500 renders, 200 agent runs, no leak, no corruption, no orphaned processes.
- Accessibility audit passed at WCAG AA.
- Cost ledger reconciles against real provider invoices within 5 %.

---

### Z. Roadmap and sequencing

Suggested milestones — adjust, but keep the dependency order.

| Milestone | Workstreams | Outcome |
|---|---|---|
| **0.2 — Foundation** | A, B, C, D, P | Renamed, tested, SQLite, keys in the vault, routes locked down |
| **0.3 — Reach** | E, F, G | Every provider, real search with citations, agent runtime v2 + MCP |
| **0.4 — Depth** | H, I, J, M | Coding agent with commands and diffs, themes that export, image pipeline with inpaint/ControlNet/upscale, chat at parity |
| **0.5 — Range** | K, L, O | Video/audio/3D via the blueprint registry, Library as an asset manager, performance pass |
| **0.6 — Product** | N, Q, R, S | Cost and observability, desktop installer, Settings, docs |
| **0.9 — Polish** | T, U, V, W, X | Accessibility, i18n, privacy switch, business model, release automation |
| **1.0** | Y | All gates green |

---

## 5. Third-party services — the full list

Add each behind the provider/adapter interfaces so none is load-bearing. Env var names given
for consistency; all are optional and all resolve through the vault (D).

**Text / multimodal:** OpenAI `OPENAI_API_KEY` · Anthropic `ANTHROPIC_API_KEY` · Google Gemini
`GEMINI_API_KEY` · OpenRouter `OPENROUTER_API_KEY` · Groq `GROQ_API_KEY` · Mistral
`MISTRAL_API_KEY` · DeepSeek `DEEPSEEK_API_KEY` · xAI `XAI_API_KEY` · Together
`TOGETHER_API_KEY` · Cerebras `CEREBRAS_API_KEY` · Vercel AI Gateway `AI_GATEWAY_API_KEY` ·
Ollama (local, no key) · LM Studio / vLLM / LiteLLM via custom base URL.

**Search / retrieval:** Brave Search `BRAVE_SEARCH_API_KEY` (default) · Tavily
`TAVILY_API_KEY` · Exa `EXA_API_KEY` · Serper `SERPER_API_KEY` · Perplexity
`PERPLEXITY_API_KEY` · DuckDuckGo HTML (no key, fallback only).

**Page reading:** Jina Reader `JINA_API_KEY` (works keyless at lower limits) · Firecrawl
`FIRECRAWL_API_KEY`.

**Hosted media:** fal.ai `FAL_KEY` · Replicate `REPLICATE_API_TOKEN` · ElevenLabs
`ELEVENLABS_API_KEY` · Deepgram `DEEPGRAM_API_KEY` · AssemblyAI `ASSEMBLYAI_API_KEY`.

**Model distribution:** Hugging Face `HF_TOKEN` (downloads, gated repos) · Civitai
`CIVITAI_API_KEY`.

**Product infrastructure:** Sentry `SENTRY_DSN` (opt-in) · PostHog `POSTHOG_KEY` (opt-in) ·
Stripe `STRIPE_SECRET_KEY` (only if W lands on a paid model) · GitHub (releases, auto-update
feed) · Apple Developer ID and Windows code-signing certificate (Q).

**Extensibility:** any MCP server the user configures (G) — this is how Safelight gets
GitHub, Linear, Slack, Notion, and database access without bespoke integrations.

---

## 6. Non-negotiables

Carry these through every workstream:

1. **Local-first.** The app must be fully functional with zero API keys and no network.
2. **Nothing leaves without consent.** No silent outbound calls. Ever.
3. **The user owns the files.** Renders stay as normal files in normal folders they chose.
4. **Calm interface.** The design language in `globals.css` is good — extend it, do not
   replace it. New surfaces use the existing tokens, radii, and type scale. No raw hex.
5. **Honest state.** The status pill's habit of telling the truth about what is down, and why,
   is the product's voice. Every new subsystem reports into it.
6. **Speed is a feature, and so is honesty about slowness.** An 11-minute render is fine if
   the app says so up front and lets the user do something else meanwhile.
7. **Agents ask before they act irreversibly.** The approval flow in Code mode is the model
   for every destructive capability added anywhere.

---

## 7. First session — start here

1. Read `README.md`, `web/src/components/Studio.tsx`, `web/src/lib/agent/run.ts`, and
   `web/src/lib/comfy/graph.ts` end to end. They define the product's shape.
2. Run `pnpm dev` and use all five modes for fifteen minutes. Note every rough edge.
3. Baseline, verified on 2026-09-26: `pnpm exec tsc --noEmit` passes clean, and
   `pnpm --dir web build` succeeds (22 routes: 2 static, 20 dynamic). It emits two Turbopack
   warnings — *"Dynamic filesystem access causes tracing of the whole project"* from
   `lib/sessions-store.ts` and `lib/studio-files.ts`, because both resolve paths at runtime
   with `process.cwd()`. Harmless in dev, but it bloats the traced output for the standalone
   build you will need in Workstream Q. Fix it there by resolving the data root once from an
   explicit env var instead of walking up from `cwd`.
4. Open Workstream **B**, then **A**, then **C**. Report back with what the test harness turns
   up before going further.

