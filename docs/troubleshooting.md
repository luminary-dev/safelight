# Troubleshooting

The status card in the sidebar is the first stop: it names each system (ComfyUI, Ollama, and
every cloud provider), tells you why something is down, and offers a fix action. Green =
ready, terracotta = degraded, red = the mode you are in has nothing to run on.

## ComfyUI offline

Symptom: status card says *"ComfyUI · Offline · run pnpm comfy"*; Image mode cannot use
local models (cloud image models still work).

- Start it: `pnpm comfy` from the repo root (or `pnpm dev` for both processes). It listens
  on `127.0.0.1:8188`.
- Check `comfyui.log` at the repo root for Python errors — a missing venv means the setup
  steps in [getting-started.md](getting-started.md) were not completed.
- If a non-default port or host is used, set `COMFY_URL` (and `NEXT_PUBLIC_COMFY_WS` for
  live progress) for the web app, and `COMFY_PORT` for `scripts/comfy.sh`.
- *"Up · live progress reconnecting"* means HTTP works but the WebSocket does not — usually
  transient; renders still finish via polling.

## A Qwen-Image 2.1 GGUF won't load

Upstream ComfyUI-GGUF (as of its Jan 2026 commit) does not recognise Qwen-Image 2.1 GGUF
files that ship without `general.architecture` metadata. Safelight's setup carries a small
local patch in `comfyui/custom_nodes/ComfyUI-GGUF/tools/convert.py` adding
`ModelQwenImage21` (it detects `img_in.weight`, `txt_in.text_norm.weight`,
`modulation.1.weight`). **Re-apply it if you re-clone the GGUF node**, or Qwen-Image 2.1
GGUF loading silently breaks. Models in other families (SD 1.5, SDXL, Flux) are unaffected.

## Models in ~/models are not seen

The wiring file `comfyui/extra_model_paths.yaml` maps the shared `~/models` tree into the
engine. `pnpm comfy` (or `pnpm dev`) generates it on first run if missing; if you started
ComfyUI some other way, copy the block from `scripts/comfy.sh` or create the file by hand,
then restart the engine and press the re-check button in the status card.

## Ollama offline / no local chat models

Symptom: *"Ollama · Offline · run ollama serve"* or *"Up · no models pulled"*.

- `ollama serve` starts it; `ollama pull llama3.2` gives Chat a model. Non-default location:
  set `OLLAMA_URL`.
- Agents (Chat's Agent toggle, Code, Design) need **tool-capable** models: `llama3.1`,
  `qwen2.5`, or a cloud model. Models without tool support get a clear error and are
  filtered out of the Code/Design pickers.
- Vision: attaching an image to a model without the `vision` tag disables send — pick a
  tagged model or a cloud model.

## Key rejected

The Keys dialog validates on save with one authenticated call and reports the result:

- *"The provider rejected this key"* — wrong or revoked key (401/403 from the provider).
  Re-copy it; check you pasted the right provider's key.
- *"Key works, but the account is rate-limited or out of quota"* — the key is fine; the
  account needs billing attention.
- *"Could not reach the provider to check the key"* — network problem or a wrong custom
  base URL (`SAFELIGHT_<PROVIDER>_BASE_URL`).
- A key that stops working later shows on the provider's row in the status card with a
  "Fix key" action.

## Port 3001 problems

- Already in use: another Safelight (or anything else) is on 3001. `lsof -i :3001` to find
  it. The port is fixed in `web/package.json` (`next dev -p 3001`); ComfyUI's CORS
  allowance in `scripts/comfy.sh` also assumes `http://localhost:3001`.
- **403 "This host is not allowed to reach the Safelight API"** — you are reaching the API
  through a hostname other than `localhost`/`127.0.0.1`. That is the DNS-rebinding guard;
  add deliberate hostnames to `SAFELIGHT_ALLOWED_HOSTS` (comma-separated) only if you know
  what you are doing.
- **403 "Cross-origin requests are not allowed"** — a mutating request carried a foreign
  `Origin` header; use the app itself or a script without an Origin header.
- Do not bind the server to `0.0.0.0`: there is no authentication layer yet
  (see [privacy-and-security.md](privacy-and-security.md)).

## Slow renders

Measured on the development machine (26 GB Apple-silicon Mac, Qwen-Image 2.1 Q4_K_M):
roughly **10 s per step at 768 px** and **14–27 s per step at 1024 px**, i.e. on the order
of **ten minutes for a 25-step 1024 px render**. This is expected, and the stage shows the
per-step progress live. What helps:

- **The first step after a cold start is by far the slowest** — it includes loading ~15 GB
  of weights. Subsequent renders with the same model are much faster per step.
- Memory pressure is the usual killer: Safelight already asks Ollama to unload resident
  models before each local render, but other memory-hungry apps push the machine into swap —
  watch the RAM bar in the sidebar.
- Render smaller (768 px), with fewer steps (Qwen-Image is tuned for 25, Flux for 20), or
  use a cloud image model for drafts.
- A render you no longer want: the stop button calls ComfyUI's interrupt.

## "Job vanished from the queue"

The render was cancelled or ComfyUI restarted mid-job. Re-generate; the prompt and settings
are still in the composer, and the job history keeps the seed.

## Legacy data

Old installs migrate automatically on first run: `data/sessions.json` and `data/themes/*.json`
into SQLite, plaintext `data/keys.json` into the encrypted vault — originals kept as
`*.migrated`. If a migration failed, the error is printed to the server console and the
original file is left in place; fix the JSON and restart. After a successful key migration,
rotate the keys and delete `keys.json.migrated`.
