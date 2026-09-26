# Safelight

Your private darkroom. Image generation, chat, coding, and design research — all running
against your own models on your own machine, with cloud models available when you want them,
and nothing leaving the machine that you did not send.

The promise is **privacy plus range**: local-first inference (ComfyUI for images, Ollama for
text), with eleven cloud providers — OpenAI, Anthropic, Gemini, OpenRouter, Groq, Mistral,
DeepSeek, xAI, Together, Cerebras, and Vercel AI Gateway — as opt-in accelerants behind an
encrypted key vault. A **Local only** switch in Settings hard-disables every outbound call,
with a visible badge and an audit log. Everything you make lands as normal files in folders
you own.

Safelight is a Luminary product, source-available under the **Business Source License 1.1**
(see [LICENSE](LICENSE) and [docs/adr/0002](docs/adr/0002-license-bsl-1.1.md)).

> **TODO(screenshots):** add one screenshot per mode here (Chat, Image, Code, Design,
> Library, Blueprints) once the UI settles.

## The six modes

Switched from the left rail (`web/src/components/Sidebar.tsx`), each with its own sessions,
searchable with ⌘K, and groupable into projects.

- **Chat** — a streaming conversation with any local Ollama model or a cloud model, rendered
  as markdown with syntax-highlighted code blocks, copy buttons, and a regenerate action.
  Attach reference photos (paperclip, drop, or paste) to vision-capable models. Toggle
  **Agent** and the model can call Safelight's image tools; hover a reply for "Use as image
  prompt" or "Use with the photo as reference" to hand it straight to Image mode. Branch a
  conversation from any message, edit-and-resend, tune per-session system prompt and sampling
  params, attach PDFs/text/CSV (extracted locally), see a live ~token/cost estimate, and use
  voice both ways through the browser's own speech engine. Agent runs are **detached**:
  reloading the page reconnects to a running agent instead of killing it.
- **Image** — an editorial split: composer on the left (model picker, prompt, aspect and
  megapixel pills, steps, seed, batch, and a "More settings" disclosure for CFG, denoise,
  negative prompt, sampler, scheduler, text encoders, VAE, LoRA), stage on the right with the
  latest render large, live progress over a WebSocket, a render queue, and a filmstrip
  filtered to this session or everything. Text-to-image and from-image modes; ⌘⏎ generates.
  Every render writes a metadata sidecar, so **Recreate** and **Vary** are one click; the
  Stage adds mask-brush **inpainting**, directional **outpainting**, upscale, and background
  removal (gated honestly on installed models); the composer adds a prompt library with
  wildcards, seed/CFG/steps **sweeps** rendered as a grid, and a memory guard that warns
  before a render would push the machine into swap. An in-app **model manager** downloads
  from Hugging Face and Civitai with checksum verification straight into `~/models`.
- **Code** — point a session at an absolute folder path (typed or picked with the built-in
  folder browser) and a tool-capable model can explore, grep, glob, read, and edit files
  inside it — and nowhere else. Any path outside the workspace pauses the run for an explicit
  Allow/Deny, and approved paths show as revocable "Also allowed" chips. `run_command`
  executes one shell command in the workspace, but only after you approve that exact command.
- **Design** — a design scout agent that searches the live web (Brave → Tavily → DuckDuckGo
  fallback chain), fetches pages behind a DNS-resolving SSRF guard, extracts the colors and
  fonts it finds, and saves finished themes to the database, rendered in the reply as live
  swatch cards. Saving enforces WCAG AA contrast in code (failing pairs are rejected with
  their ratios named); a saved theme can be applied live to Safelight itself and exported as
  CSS variables, a Tailwind v4 `@theme` block, or DTCG design-tokens JSON.
- **Library** — a real asset manager over everything ever rendered: SQLite-indexed with
  full-text prompt search, model/tag/favorite/date filters, generated thumbnails, a
  virtualized grid, metadata inspector, compare slider, duplicate detection, and bulk
  export/delete — plus the "Edit in Image" shortcut on any render.
- **Blueprints** — all 116 workflow templates the vendored render engine ships, parsed into
  runnable capabilities: a searchable catalog grouped by image/video/audio/3D/utility with
  honest ready/missing chips naming exactly which model files each one still needs, and a
  generated run form for any that are ready.

## Capability matrix

| Capability | Local | Cloud | Notes |
|---|---|---|---|
| Chat | Ollama | 11 providers (OpenAI, Anthropic, Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, Cerebras, AI Gateway) | streaming, markdown, vision, attachments, voice, branching |
| Image generation | ComfyUI (Qwen-Image, Flux, SDXL, SD 1.5) | OpenAI, Gemini | txt2img + img2img/reference edit |
| Image editing | Qwen-Image references | providers flagged `edit` | "Edit in Image" from any render |
| Coding agent | any tool-capable model | any tool-capable model | file tools + `run_command` behind per-command approval |
| Design research | any tool-capable model | any tool-capable model | web search, page fetch, WCAG-AA-gated themes that apply and export |
| Agent tool loop | Ollama (tool-capable models) | all eleven providers | detached runs that survive reloads, per-project memory, sub-agents, spend limits, cost ledger |
| Video / audio / 3D | ComfyUI blueprints (registry of 116) | — | gated on installed models; outputs collected and served |
| MCP tools | user-added servers (stdio) | user-added servers (HTTP) | plug icon in the sidebar; non-read-only tools ask Allow/Deny before every call |
| Data portability | `/api/export` / `/api/import` | — | full JSON dump, never includes keys |

## Install

Three ways to run Safelight:

1. **Desktop app (macOS)** — build `desktop/` (Tauri 2; see [desktop/README.md](desktop/README.md)).
   The app attaches to a running Safelight server or spawns its own with its own data
   directory, and uses any running ComfyUI/Ollama. Unsigned for now; needs Node 22+.
2. **Docker** — the headless/server path: [docs/deploy.md](docs/deploy.md)
   (`docker-compose.yml`; your local GPL ComfyUI clone is bind-mounted, never baked into an
   image).
3. **From source** — below.

## Setup from scratch

Prerequisites: Node 22+, pnpm, Python 3.13 with [`uv`](https://docs.astral.sh/uv/), and
optionally [Ollama](https://ollama.com) for local chat models.

```bash
# 1. ComfyUI (supervised over HTTP, never vendored — it is GPL-3.0; see docs/adr/0001)
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git comfyui
git clone --depth 1 https://github.com/city96/ComfyUI-GGUF.git comfyui/custom_nodes/ComfyUI-GGUF
cd comfyui && uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -r requirements.txt -r custom_nodes/ComfyUI-GGUF/requirements.txt
cd ..

# 2. The web app
cd web && pnpm install && cd ..

# 3. Run
pnpm dev          # ComfyUI (:8188) + web (:3001) together
# or separately
pnpm comfy        # backend on :8188
pnpm web          # frontend on http://localhost:3001
```

### GGUF loader patch

Upstream ComfyUI-GGUF (as of its Jan 2026 commit) does not recognise Qwen-Image 2.1 GGUF
files that ship without `general.architecture` metadata.
`comfyui/custom_nodes/ComfyUI-GGUF/tools/convert.py` carries a small local patch adding
`ModelQwenImage21` (detects `img_in.weight`, `txt_in.text_norm.weight`,
`modulation.1.weight`). **Re-apply it if you re-clone the node**, or Qwen-Image 2.1 GGUF
loading silently breaks.

### Models

Models live outside the repo in `~/models`, wired to ComfyUI via
`comfyui/extra_model_paths.yaml`:

```
~/models/
  Qwen-Image-2.1-Uncensored-GGUF/   the Qwen-Image 2.1 GGUF, text encoder, VAE
  diffusion_models/                 other GGUF or safetensors transformers
  checkpoints/                      all-in-one SD 1.5 / SDXL checkpoints
  text_encoders/  vae/  loras/
```

Drop files in and press the re-check button in the status card. GGUF transformers load
through the GGUF node, safetensors through the standard loader, checkpoints through the
checkpoint loader. Qwen-Image, Flux, SDXL, and SD 1.5 are recognised by file name
(`lib/comfy/models.ts`) and get family-appropriate sampling defaults (`defaultsForModel`
in `lib/safelight-state.ts`): e.g. Qwen-Image 25 steps / cfg 1 / euler·simple, SDXL 30
steps / cfg 6 / dpmpp_2m·karras.

## Verification

```bash
pnpm verify           # typegen + typecheck + lint + unit tests with coverage thresholds
                      # + quality-gate drift check + production build
pnpm --dir web e2e    # 16 Playwright tests against an isolated instance (throwaway data,
                      # backends deliberately unreachable — never your real data)
```

577 unit tests across 58 files run in under two seconds; coverage is measured over the full
shipped surface (routes and components included) with ratcheting floors — see
[docs/quality-gates.md](docs/quality-gates.md) for the honest 1.0 gate table, which CI
verifies against a fresh run. CI (`.github/workflows/verify.yml`) adds a production
dependency audit and a full-history gitleaks secret scan on every push and PR.

## Data layout — what lives where

| Path | What | Notes |
|---|---|---|
| `data/safelight.db` | SQLite (WAL): sessions, projects, themes, settings, usage, rate limits, search cache | migrations are numbered and append-only |
| `data/backups/` | daily `VACUUM INTO` copies, newest 7 kept | automatic |
| `data/keys.enc.json` | provider API keys, AES-256-GCM at rest | vault key lives in the **macOS Keychain** (service `safelight-vault`); `SAFELIGHT_VAULT_KEY` env or a mode-600 `data/.vault-key` file elsewhere |
| `outputs/` | every render (cloud results under `outputs/cloud/`) | plain image files you own |
| `inputs/` | uploaded reference photos | shared by Chat and Image mode |

A pre-vault plaintext `data/keys.json` and a pre-SQLite `data/sessions.json` are imported
automatically on first run and kept as `*.migrated` — rotate your keys, then delete the
migrated file. Full data portability: `GET /api/export` downloads everything you made as one
JSON document (never keys); `POST /api/import` merges it back by id.

## Cloud keys

Sidebar → key icon. Keys are validated with one cheap authenticated call on save ("Key
works" / "The provider rejected this key"), stored only in the encrypted vault, and only
ever used server-side — the API returns at most a `…abcd` hint. Environment variables
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, … — see `.env.example` for all
eleven) work as fallbacks, and each provider accepts a custom base URL (Azure OpenAI, vLLM,
LiteLLM gateways) from the keys dialog or `SAFELIGHT_<PROVIDER>_BASE_URL`. OpenAI and Gemini
add image models; all eleven add chat models. Every cloud call lands in a cost ledger with
daily/monthly spend limits (global and per-provider) in Settings. Cloud renders are saved to `outputs/cloud/` so they appear
in the Library like local ones. See [docs/providers-and-keys.md](docs/providers-and-keys.md).

## Memory on a 26 GB Mac

Qwen-Image 2.1 Q4_K_M plus its text encoder takes about 15 GB. A resident Ollama chat model
(a 24B model is ~14 GB) on top of that pushes the machine into swap, so the generate route
asks Ollama to unload every resident model before queuing a local render
(`unloadOllamaModels()` in `lib/generate-core.ts`). Expect roughly 10 s per step at 768 px
and 14–27 s per step at 1024 px depending on load — around ten minutes for a 25-step
1024 px render — and a much slower first step after a cold start because it includes the
model load. The sidebar's status card shows live RAM pressure from ComfyUI's
`/system_stats`.

## Status card

The status row in the sidebar polls the real backends (every 15 s when healthy, every 4 s
while something is down): green means ready, terracotta means degraded (for example ComfyUI
offline but cloud models available), red means the mode you are in has nothing to run on.
Click it for the per-system breakdown — ComfyUI, Ollama, and each cloud provider — with the
reason and a fix action.

## Layout

```
safelight/
  comfyui/    ComfyUI backend + ComfyUI-GGUF node (cloned, not committed; see patch note)
  web/        Next.js app — the entire product surface, http://localhost:3001
  desktop/    Tauri 2 desktop shell (attach-or-spawn supervisor)
  scripts/    launchers (comfy.sh, dev.sh) and CI helpers
  data/       SQLite DB, encrypted keys, backups (gitignored)
  outputs/    generated images land here (gitignored)
  inputs/     uploaded reference images (gitignored)
  docs/       documentation and architecture decision records
```

Deep links: `?mode=chat|image|code|design|library|blueprints` opens a mode,
`?theme=light|dark` forces a theme for that load.

## Documentation

- [Getting started](docs/getting-started.md)
- Modes: [Chat](docs/modes/chat.md) · [Image](docs/modes/image.md) ·
  [Code](docs/modes/code.md) · [Design](docs/modes/design.md) ·
  [Library](docs/modes/library.md)
- [Providers and keys](docs/providers-and-keys.md)
- [Agents and tools](docs/agents-and-tools.md)
- [Privacy and security](docs/privacy-and-security.md)
- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · agent conventions: [AGENTS.md](AGENTS.md)

## License

Business Source License 1.1 — source-available; personal, educational, and internal
production use is granted, offering Safelight as a hosted service to third parties is not.
Change date 2030-09-26, change license Apache-2.0. See [LICENSE](LICENSE).
