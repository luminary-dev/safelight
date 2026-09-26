# Safelight

Your private darkroom. Image generation, chat, coding, and design research — all running
against your own models on your own machine, with cloud models available when you want them,
and nothing leaving the machine that you did not send.

The promise is **privacy plus range**: local-first inference (ComfyUI for images, Ollama for
text), with eleven cloud providers as opt-in accelerants behind an encrypted key vault. A
**Local only** switch in Settings hard-disables every outbound call. Everything you make
lands as normal files in folders you own.

Safelight is a Luminary product, source-available under the **Business Source License 1.1**
(see [LICENSE](LICENSE)). Unlicensed Safelight is fully functional for personal use.

## What you get

Six modes, switched from the left rail, each with its own sessions and ⌘K search:

- **Chat** — streaming markdown chat with any local Ollama model or cloud model; vision
  attachments, PDFs, voice, branching, and an agent toggle that lets the model drive the
  image tools.
- **Image** — prompt on the left, renders on the right: live progress, queue, filmstrip,
  Recreate/Vary from any render's sidecar, inpaint/outpaint/upscale/background-removal,
  prompt library with wildcards, and parameter sweeps rendered as a grid.
- **Code** — point a session at a folder and a tool-capable model can read, grep, and edit
  inside it — and nowhere else; every shell command needs your explicit approval.
- **Design** — a scout agent that researches the live web and returns applyable,
  WCAG-AA-checked color themes you can export as CSS, Tailwind, or design tokens.
- **Library** — everything you ever rendered: full-text prompt search, filters, thumbnails,
  compare, duplicates, bulk export.
- **Blueprints** — 116 ready-made ComfyUI workflow templates (image/video/audio/3D) with
  honest chips naming exactly which model files each one still needs.

## Requirements

- macOS on Apple Silicon (16 GB RAM minimum for small image models; 24 GB+ recommended —
  see [Choosing a model](#2-choosing-an-image-model-by-ram)). Linux works via
  [Docker](docs/deploy.md).
- [Homebrew](https://brew.sh) to install the prerequisites below.

```bash
brew install node pnpm uv          # Node 22+, pnpm, and uv (manages Python for the engine)
brew install ollama                # optional — local chat models
```

## Install

### Option A — the macOS app

Build once, then use Safelight like any other app. One extra tool is needed (Rust, for the
app shell):

```bash
brew install rustup && rustup-init -y && source "$HOME/.cargo/env"

git clone https://github.com/luminary-dev/safelight.git
cd safelight

# The image engine (ComfyUI, supervised over HTTP — required for local image generation)
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git comfyui
git clone --depth 1 https://github.com/city96/ComfyUI-GGUF.git comfyui/custom_nodes/ComfyUI-GGUF
(cd comfyui && uv venv --python 3.13 .venv && \
  uv pip install --python .venv/bin/python -r requirements.txt -r custom_nodes/ComfyUI-GGUF/requirements.txt)

# The app
(cd web && pnpm install && pnpm build)
pnpm --dir desktop install
pnpm --dir desktop assemble
pnpm --dir desktop tauri build

# Install and open (unsigned build, so clear the quarantine flag once)
cp -R desktop/src-tauri/target/release/bundle/macos/Safelight.app /Applications/
xattr -dr com.apple.quarantine /Applications/Safelight.app
open /Applications/Safelight.app
```

The app runs its own server with its own data folder under
`~/Library/Application Support/com.luminary.safelight/` and quits cleanly. For local image
generation, start the engine first (`pnpm comfy` from the repo, or any ComfyUI install on
port 8188) — the app attaches to whatever is running and says so honestly in the status
card when nothing is.

### Option B — run in the browser

Same clone and engine steps as above (skip the Rust/desktop parts), then:

```bash
pnpm dev          # engine (:8188) + app together → http://localhost:3001
# or separately:
pnpm comfy        # just the image engine
pnpm web          # just the app
```

### Option C — Docker (headless / server)

See [docs/deploy.md](docs/deploy.md). Your ComfyUI clone is bind-mounted, never baked into
an image.

## Get models

Safelight ships no model weights — you pick what runs on your machine.

### 1. Image models — the easy way (in-app)

Open the **model manager** (download icon at the top of the sidebar). Search Hugging Face
or Civitai directly, and downloads land in `~/models` with checksum verification and a live
progress queue. For gated or authenticated files, paste a Hugging Face token or Civitai API
key under **API keys** (key icon) first.

### 2. Choosing an image model by RAM

| Machine | Good fit | Size |
|---|---|---|
| 16 GB | SD 1.5 or SDXL all-in-one checkpoint | 2–7 GB |
| 24–32 GB | Qwen-Image 2.1 GGUF **Q4_K_M** + its text encoder + VAE | ~15 GB total |
| 48 GB+ | larger GGUF quants, Flux | 20 GB+ |

On a 26 GB machine, Qwen-Image 2.1 at 25 steps takes roughly ten minutes per 1024 px image;
768 px stays comfortably in RAM. The composer warns before a render would push the machine
into swap, and the sidebar status card shows live RAM pressure.

### 3. Image models — the manual way

Drop files into `~/models` (created on first use, wired to the engine automatically):

```
~/models/
  checkpoints/        all-in-one SD 1.5 / SDXL checkpoints (.safetensors)
  diffusion_models/   GGUF or safetensors transformers (Qwen-Image, Flux)
  text_encoders/      the matching text encoder(s)
  vae/                the matching VAE
  loras/              LoRA files
```

Then press the re-check button in the sidebar status card. Models are recognised by file
name and get family-appropriate sampling defaults automatically.

### 4. Chat models (local)

```bash
ollama pull qwen3:8b        # or any model from ollama.com/library
```

Anything Ollama serves appears in the model picker in Chat mode. Tool-capable models can
also drive Code, Design, and the Image agent.

### 5. Cloud models (optional)

Sidebar → key icon → paste a key. Keys are validated with one cheap call on save, stored
AES-256-GCM-encrypted (the vault key lives in your macOS Keychain), and never leave the
server side. OpenAI and Gemini add image models; all eleven providers add chat. Every cloud
call lands in a cost ledger with daily/monthly spend limits in Settings. Prefer zero cloud?
Flip **Local only** in Settings and every outbound call is refused, verifiably.

## Where your files live

| Path | What |
|---|---|
| `outputs/` | every render, as plain image files (cloud results under `outputs/cloud/`) |
| `inputs/` | reference photos you attach |
| `data/` | the SQLite database, encrypted keys, and daily backups |
| `~/models` | model weights |

The desktop app keeps its own copies of these under
`~/Library/Application Support/com.luminary.safelight/`. `GET /api/export` downloads
everything you made as one JSON document (never keys); `POST /api/import` merges it back.

## Troubleshooting

- **Status card red / "ComfyUI offline"** — start the engine (`pnpm comfy`) or check
  port 8188. Click the status card for a per-system breakdown with the reason and a fix.
- **macOS blocks the app** — it is unsigned for now; the `xattr` command in the install
  step clears the flag, or right-click → Open the first time.
- **A Qwen-Image 2.1 GGUF won't load** — re-apply the small loader patch described in
  [docs/troubleshooting.md](docs/troubleshooting.md) if you re-cloned the GGUF node.
- More: [docs/troubleshooting.md](docs/troubleshooting.md).

## Documentation

- [Getting started](docs/getting-started.md)
- Modes: [Chat](docs/modes/chat.md) · [Image](docs/modes/image.md) ·
  [Code](docs/modes/code.md) · [Design](docs/modes/design.md) ·
  [Library](docs/modes/library.md)
- [Providers and keys](docs/providers-and-keys.md) ·
  [Privacy and security](docs/privacy-and-security.md)
- [Architecture](docs/architecture.md) · desktop shell: [desktop/README.md](desktop/README.md)
- Contributing / developing: [CONTRIBUTING.md](CONTRIBUTING.md) (verification, tests, and
  quality gates live there and in [docs/quality-gates.md](docs/quality-gates.md))

## License

Business Source License 1.1 — source-available; personal, educational, and internal
production use is granted, offering Safelight as a hosted service to third parties is not.
Change date 2030-09-26, change license Apache-2.0. See [LICENSE](LICENSE).
