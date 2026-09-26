# Getting started

Safelight is two processes: a Next.js app (the whole product surface, port **3001**) and a
supervised ComfyUI backend (local image inference, port **8188**). Ollama (port 11434) is
optional and adds local chat models.

## Prerequisites

- Node 22+ and pnpm
- Python 3.13 and [`uv`](https://docs.astral.sh/uv/) (for ComfyUI's venv)
- macOS is the primary target (the key vault uses the macOS Keychain; other platforms fall
  back to a generated key file)
- Optional: [Ollama](https://ollama.com) — `ollama pull llama3.2` for chat,
  tool-capable models like `llama3.1` or `qwen2.5` for the agents

## Install

From the repo root:

```bash
# ComfyUI — installed from upstream, supervised over HTTP, never committed (GPL-3.0; see adr/0001)
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git comfyui
git clone --depth 1 https://github.com/city96/ComfyUI-GGUF.git comfyui/custom_nodes/ComfyUI-GGUF
cd comfyui && uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -r requirements.txt -r custom_nodes/ComfyUI-GGUF/requirements.txt
cd ..

# Web app
cd web && pnpm install && cd ..
```

**GGUF patch:** upstream ComfyUI-GGUF does not detect Qwen-Image 2.1 GGUFs that lack
`general.architecture` metadata. This repo's setup relies on a small local patch to
`comfyui/custom_nodes/ComfyUI-GGUF/tools/convert.py` adding a `ModelQwenImage21` detection
(`img_in.weight`, `txt_in.text_norm.weight`, `modulation.1.weight`). Re-apply it after any
re-clone of the node.

## Add a model

Models live outside the repo in `~/models`, read by ComfyUI through
`comfyui/extra_model_paths.yaml`. Place a GGUF or safetensors transformer in
`~/models/diffusion_models/` (or an all-in-one checkpoint in `~/models/checkpoints/`, text
encoders / VAEs / LoRAs in their folders) and press re-check in the status card. Family
(Qwen-Image / Flux / SDXL / SD 1.5) is recognised by filename and sets sane sampling
defaults.

## Run

```bash
pnpm dev      # scripts/dev.sh: ComfyUI in the background + web dev server; Ctrl-C stops both
# or separately:
pnpm comfy    # scripts/comfy.sh → ComfyUI on :8188, outputs/ and inputs/ as its folders
pnpm web      # Next.js dev server on http://localhost:3001
```

Open **http://localhost:3001**. The status card in the sidebar tells you honestly what is up:
ComfyUI, Ollama, and each cloud provider, with a reason and a fix action when something is
down.

First launch of a model takes a while because the weights load into memory — Qwen-Image 2.1
at Q4_K_M plus its int8 text encoder needs roughly 15 GB.

## Optional: cloud keys

Sidebar → key icon → paste an OpenAI, Anthropic, Gemini, OpenRouter, or Groq key. It is
validated immediately
and stored encrypted (vault key in the macOS Keychain). See
[providers-and-keys.md](providers-and-keys.md).

## Verify a working tree

```bash
pnpm verify   # typecheck + lint + unit tests + production build
```

## Where your data is

- `data/safelight.db` — sessions, projects, themes, settings (SQLite, daily backups in
  `data/backups/`)
- `outputs/` — every render; `inputs/` — uploaded reference photos
- `GET /api/export` — everything you made as one JSON file (never keys);
  `POST /api/import` restores it
