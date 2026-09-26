# Architecture

Safelight is a Next.js app supervising two local backends over HTTP. There is no desktop
shell yet (Tauri is planned, build brief Workstream Q); `scripts/dev.sh` runs ComfyUI in the
background and the web dev server in the foreground.

```
┌─ scripts/dev.sh ────────────────────────────────────────────────────┐
│  comfy.sh → ComfyUI :8188  (--output-directory outputs,             │
│             --input-directory inputs, CORS for localhost:3001)      │
│  pnpm --dir web dev → Next.js :3001                                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTP + WebSocket
┌─ web/ (Next.js 16, React 19)─┴──────────────────────────────────────┐
│  src/middleware.ts   host allowlist + origin check on /api/*        │
│  src/app/api/        every capability is a route (below)            │
│  src/components/     5 mode workspaces over one shell               │
│  src/lib/            agent runtime · providers · search · comfy ·   │
│                      db · secrets                                   │
└─────────────────────────────────────────────────────────────────────┘
      Ollama :11434 (optional)      OpenAI / Anthropic / Gemini (opt-in keys)
```

Rules the code follows: the UI never talks to a provider directly — always through a route;
anything touching disk or keys is `server-only`; ComfyUI is supervised, never vendored
([adr/0001](adr/0001-comfyui-is-supervised-not-vendored.md)).

## Components (`web/src/components/`)

- **`Safelight.tsx`** — the shell and cross-mode state owner (~900 lines): mode switching,
  sessions/projects CRUD with debounced persistence, the render job lifecycle (queue, poll,
  resume after reload), status rows, and the handoffs between modes.
- **`Sidebar.tsx`** — wordmark, ⌘K search, the mode nav (Chat · Image · Code · Design ·
  Library — the only mode switcher), the current mode's session list grouped Today/Earlier
  with rename/move/delete, the project switcher, and the status card with a live RAM bar.
- **`ChatMode.tsx`** — the shared conversation engine for Chat, Code, and Design,
  parameterised by `agentEndpoint`, `agentBody`, `agentLocked`, `showControls`,
  `onApprovePath`. Markdown replies, attachments, the NDJSON reader, tool cards, theme
  swatches, approval prompts, stop/regenerate.
- **`ChatWorkspace` / `CodeWorkspace` / `DesignWorkspace`** — thin mode wrappers around
  `ChatMode` (Code adds the folder bar, browser, and "Also allowed" chips).
- **`Composer.tsx` + `ImageControls.tsx` + `Stage.tsx`** — Image mode's split.
- **`Library.tsx`**, **`ModelPicker.tsx`**, **`KeysDialog.tsx`**, **`ProjectSwitcher.tsx`**,
  **`FolderBrowser.tsx`**, `ui/` (shadcn primitives).

## Libraries (`web/src/lib/`)

| Module | Role |
|---|---|
| `agent/run.ts` | provider-neutral tool loop: OpenAI/Anthropic/Gemini/Ollama adapters, rounds budget (24 default, 60 for code), parallel tool calls, retries with backoff, NDJSON `AgentEvent`s |
| `agent/tools.ts` | studio toolset (generate/edit image, list models/recents) + `ToolDef`/`ToolContext`/`AgentEvent` types |
| `agent/code-tools.ts` | workspace file tools with realpath confinement and per-path approvals |
| `agent/design-tools.ts` | web search, SSRF-guarded page fetch, theme saving |
| `agent/approvals.ts` | in-flight Allow/Deny questions (180 s timeout to deny) |
| `search/` | `SearchProvider` interface, Brave / Tavily / DuckDuckGo adapters, failover chain with a 1 h SQLite cache |
| `providers/` | keys + vault access, per-provider chat/image adapters, cloud model catalog, key validation |
| `secrets/vault.ts` | AES-256-GCM envelope; key from env / macOS Keychain / mode-600 file |
| `comfy/` | HTTP client, per-request graph builder, model catalog scan + family classification, types |
| `db/` | better-sqlite3: numbered migrations, legacy-JSON import, daily `VACUUM INTO` backups, session/project/theme repositories, token-bucket rate limit |
| `generate-core.ts` | request sanitising (every numeric clamped), local queueing (Ollama unload first), cloud rendering to `outputs/cloud/`, job status/wait |
| `safelight-files.ts` | `OUTPUT_DIR`/`INPUT_DIR`, `safeJoin` traversal guard, image-ref parsing |
| `safelight-state.ts` | settings shape, per-family sampling defaults, job types, stage labels |
| `ollama/client.ts` | chat streaming, model listing, unload |
| `session-types.ts`, `presets.ts`, `chat-images.ts`, `friendly-names.ts` | session/project types + auto-titles, size presets and seeds, wire-message → provider-turn conversion, model display names |

## API routes (`web/src/app/api/`)

| Route | Purpose |
|---|---|
| `chat` (+ `chat/models`) | streamed plain-text chat; merged Ollama+cloud model list |
| `agent` / `code` / `design` | NDJSON agent runs per toolset |
| `code/approve` | answers a pending path approval |
| `code/browse` | folder picker listing (home-confined, rate-limited) |
| `generate`, `jobs/[id]`, `interrupt` | queue a render, poll it, cancel it |
| `models` | ComfyUI catalog + cloud image models |
| `gallery` | list (400 newest) and delete renders |
| `upload`, `view` | put files into `inputs/`, serve images from either folder |
| `sessions`, `sessions/[id]`, `projects`, `projects/[id]` | persistence CRUD |
| `keys` | key status/set/validate (never returns a key) |
| `export`, `import` | full data portability, keys excluded |
| `health` | ComfyUI reachability + `/system_stats` |

## Persistence

Single SQLite database `data/safelight.db` (WAL, foreign keys on): `projects`, `sessions`
(kind-checked, JSON `data` column), `themes`, `settings`, `usage_events`, `rate_limits`,
`search_cache`, `schema_migrations`. Migrations are numbered and append-only; a fresh or
empty DB imports the pre-SQLite `sessions.json`/`themes/*.json` once (kept as `*.migrated`);
a daily `VACUUM INTO` backup keeps the newest 7 in `data/backups/`. Client-side, sessions
are written through debounced PATCHes and UI preferences live in `localStorage` under
`safelight.*` (with a read-old shim for pre-rename `studio.*` keys).

## Design language

`app/globals.css` — "Soft & calm": paper `#f7f7f5` light default, white cards, gray ink
ramp, lime accent, a zinc dark companion; Outfit for display/body, JetBrains Mono for
captions and counts; 16–24 px radii, pill buttons, whisper shadows. Components use only the
semantic tokens (`text-ink`, `bg-paper-2`, `bg-terracotta-wash`, …) — never raw hex. The
theme is applied pre-paint by an inline script in `layout.tsx`; deep links `?mode=` and
`?theme=` are honoured.

## Decision records

- [adr/0001 — ComfyUI is supervised over HTTP, never redistributed](adr/0001-comfyui-is-supervised-not-vendored.md)
- [adr/0002 — Source-available under BSL 1.1](adr/0002-license-bsl-1.1.md)
