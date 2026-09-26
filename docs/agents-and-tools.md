# Agents and tools

One provider-neutral tool loop powers Chat's agent mode, Code mode, and Design mode.
Code: `web/src/lib/agent/run.ts` (the loop and per-provider adapters), `tools.ts` (studio
toolset + shared types), `code-tools.ts`, `design-tools.ts`, `approvals.ts`.

## The runtime

`runAgent(provider, model, turns, ctx)` picks an adapter — OpenAI, Anthropic, Gemini, or
Ollama (`/api/chat` with `tools`) — and runs a rounds-bounded loop: send the conversation
with the tool definitions, execute any tool calls the model makes, feed results back, repeat
until the model answers in plain text.

- **Rounds budget:** default 24 rounds; routes can pass their own (`/api/code` uses 60,
  capped at 200). Hitting the budget emits a status event saying so.
- **Parallel tools:** independent tool calls in one turn execute concurrently; results are
  returned in call order.
- **Retries:** transient provider failures (429 / 5xx / 529) retry up to 3 times with
  exponential backoff, narrated as `status` events ("Provider busy — retrying…").
- **Cancellation:** the request's `AbortSignal` propagates into provider calls and the
  render-wait loop; Stop in the UI aborts the fetch.
- Tool-incapable Ollama models fail with an actionable message (pick a cloud model, or a
  tool-capable local one such as `llama3.1` or `qwen2.5`).

## The NDJSON event stream

Agent routes (`/api/agent`, `/api/code`, `/api/design`) respond with
`application/x-ndjson` — one JSON event per line (`AgentEvent` in `lib/agent/tools.ts`):

| Event | Fields | Meaning |
|---|---|---|
| `text` | `text` | a model reply segment |
| `tool` | `id`, `name`, `args`, `state: running\|done\|error`, `result?`, `images?`, `note?` | tool lifecycle; re-emitted as state changes (e.g. render tick notes like "Rendering · 41s") |
| `approval` | `id`, `path`, `tool` | the run is paused waiting for the user (Code mode) |
| `status` | `text` | progress narration (retries, budget) |
| `error` | `text` | the run failed |
| `done` | — | always the last line |

The client (`ChatMode.tsx`) folds these into the last assistant message: text accumulates,
tools render as cards (with image results and an "Edit in Image" action), approvals render
as Allow/Deny prompts.

## Toolsets

The `ToolContext.toolset` swaps the tool table per mode; the system prompt swaps with it.

**Studio** (Chat's Agent toggle, `/api/agent`):
`generate_image` (prompt, aspect, model, count ≤ 4), `edit_image` (image ref + instruction,
`<image1>` phrasing added for Qwen), `list_models`, `list_recent_images`. Local renders wait
for ComfyUI synchronously with elapsed-time ticks; the UI's selected image model is the
default via `preferredModel`.

**Code** (`/api/code`): `list_files`, `glob`, `grep`, `read_file`, `edit_file`,
`multi_edit`, `write_file`, `delete_file`, `move_file` — all root-scoped with
symlink-resolved confinement. No command execution. Details and limits:
[modes/code.md](modes/code.md).

**Design** (`/api/design`): `search_web` (Brave → Tavily → DuckDuckGo chain with a 1-hour
SQLite cache), `fetch_page` (SSRF-guarded), `save_theme`. Details:
[modes/design.md](modes/design.md).

## Approvals

Code-mode path approvals live in a module-level map on the server
(`lib/agent/approvals.ts`): the run parks on a promise, the UI answers through
`POST /api/code/approve { id, allow }`, and an unanswered question resolves to **deny after
180 seconds**. Grants the user makes are persisted on the session as `approvedPaths` and
sent with subsequent runs; they are visible and revocable in the Code workspace. This
ask-before-acting flow is the repo's model for any future destructive capability
(see [AGENTS.md](../AGENTS.md)).
