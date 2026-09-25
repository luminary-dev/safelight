# Safelight

Your private darkroom: image generation and chat with your own models, local or cloud.
(A Luminary product; the repo folder is still `studio/` until the running services are
stopped for a rename.) ComfyUI does the local
inference, Ollama serves local chat models, and OpenAI, Anthropic, and Gemini plug in with
an API key. A Next.js app on top gives you model selection, prompts, text to image, image
editing, chat, and a gallery.

## Layout: editorial split

- **Left, the composer**: session switcher, Text to image / From image toggle, a prompt
  field on a hairline baseline, then a clean settings form (model picker, aspect
  and megapixel pills with the exact size, steps, seed, batch) and a "More settings"
  disclosure for CFG, strength, negative prompt, sampler, scheduler, encoders, VAE, LoRA.
  Generate sits at the bottom of the form; Cmd+Enter works from the prompt.
- **Right, the stage**: the latest or selected render large in a card, a live progress
  state while rendering, actions (edit, save, open, delete), and a filmstrip of earlier
  renders filtered to this session or everything. Click the image for a full-size viewer.
- **Chat** is a first-class mode, switched from the header. Same split: left column holds
  the chat switcher, model picker, and agent toggle; right column is the conversation with
  the composer. Agent mode, copy, and use-as-prompt carry over.
- **Themes**: light is the default; the sun / moon button switches to dark. Two states only,
  applied before first paint.
- Deep links: `?mode=chat` opens chat, `?systems=1` opens the status panel, `?picker=1`
  opens the model picker, `?theme=light|dark` forces a theme for that load.

## UI stack

Next.js 16, Tailwind v4, and shadcn/ui (radix-nova style) with the semantic tokens mapped
onto the Safelight palette in `web/src/app/globals.css`. The design is "Soft & calm" (option
1b from the redesign doc): airy `#f7f7f5` light mode by default with white cards, a gray text
ramp, and a gentle lime accent (`#84cc16` fills, `#5a9e08` text); dark is a quiet zinc
companion with the lime brightened. Type is Outfit throughout with JetBrains Mono for
captions and counts. Shapes are generously rounded (pill buttons, 16–24px cards), shadows
soft; new renders fade in gently. Glass (`.glass`) is used only on popovers. The model picker is a Popover +
Command combobox grouped by source (On this Mac, OpenAI, Anthropic, Gemini) with search;
segmented controls are ToggleGroups; dropdowns are shadcn Selects. Icons are lucide.
Dev flags for QA: `?picker=1`, `?systems=1`, `?mode=chat`.

## Reference photos in chat

Attach images in Chat with the paperclip, by dropping them on the composer, or by pasting.
They upload to the same input folder Image mode uses, so a reference can flow straight into a
render. Pull vision-capable Ollama models with `ollama pull <name>` and they appear in the
picker tagged with their capabilities. Vision goes to every provider (OpenAI, Anthropic, Gemini, and Ollama models that report
the `vision` capability; others are flagged and the send button is disabled while an image is
attached).

Hover a reply for **Use as image prompt** (fills prompt and negative prompt in Image mode) or
**Use with the photo as reference** (also switches to From image with the photo attached as
image 1).

## Agent mode

Toggle **Agent** beside the chat model picker. The model can then call studio tools:
`generate_image` (renders with the model selected in Image mode, or one it picks),
`edit_image` (changes an existing render by reference), `list_models`, and
`list_recent_images`. Tool activity shows as cards in the reply with the resulting images,
and each image has an "Edit in Image" shortcut. Works with OpenAI, Anthropic, Gemini, and
tool-capable Ollama models; models without tool support get a clear error. Local renders block
the agent until ComfyUI finishes, so expect a few minutes per image on this machine. Agent
runs stream as newline-delimited JSON from `/api/agent`.

## Projects and sessions

The project pill under the header scopes both modes to one project: its chats in Chat, its
image sessions in Image. New sessions are filed into the active project; "All projects" shows
everything, filed and unfiled. Create, rename, and delete projects from the pill's popover —
deleting a project keeps its sessions and moves them to All projects.

The left rail lists chats (in Chat) and image sessions (in Image). New, rename (double-click
or the pencil), switch, and delete with confirmation. Each chat keeps its own messages and
model; each image session keeps its render history, current result, and unsent prompt draft.
Sessions are stored in `data/sessions.json` and survive browser resets. Renders still running
when the page was closed resume polling on the next load. Deleting an image session leaves
its images in the gallery.

## Cloud keys

Header → Keys. Keys are saved to `data/keys.json` (gitignored, mode 600) and only ever used
server-side. Environment variables `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`
also work. OpenAI and Gemini add image models; all three add chat models. Cloud results are
saved to `outputs/cloud/` so they appear in the gallery like local renders.

## Memory on a 26 GB Mac

Qwen-Image 2.1 Q4_K_M plus its text encoder takes about 15 GB. A resident Ollama chat model
(Cydonia 24B is 14 GB) on top of that pushes the machine into swap, and the first sampling
step can take minutes. The generate route therefore asks Ollama to unload every resident
model before queuing a local render. Expect roughly 10 s per step at 768 px and 14 s per
step at 1024 px once the model is warm; the first step after a cold start is slower because
it includes the model load.

## Status pill

The pill in the header polls the real backends every few seconds (faster while something
is down): green means ready, terracotta means degraded (for example ComfyUI offline but
cloud models available), red means the mode you are in has nothing to run on. Hover it for
the reason.

```
studio/
  comfyui/    ComfyUI backend + ComfyUI-GGUF node (cloned, not committed; see patch note below)
  web/        Next.js UI on http://localhost:3001
  scripts/    launchers
  outputs/    generated images land here
  inputs/     uploaded reference images
```

Models live outside the repo in `~/models`. ComfyUI reads them through
`comfyui/extra_model_paths.yaml`:

```
~/models/
  Qwen-Image-2.1-Uncensored-GGUF/   the Qwen-Image 2.1 GGUF, text encoder, VAE
  diffusion_models/                 other GGUF or safetensors transformers
  checkpoints/                      all-in-one SD 1.5 / SDXL checkpoints
  text_encoders/  vae/  loras/
```

## Run

```bash
pnpm dev          # ComfyUI + web together
# or separately
pnpm comfy        # backend on :8188
pnpm web          # frontend on :3001
```

First launch of a model takes a while because the weights are loaded into memory.
Qwen-Image 2.1 at Q4_K_M plus the int8 text encoder needs roughly 15 GB.

## Adding models

Drop files into the `~/models` folders above and press the refresh button in the header.
GGUF transformers are loaded with the GGUF node, safetensors transformers with the standard
loader, and checkpoints with the checkpoint loader. Qwen-Image, Flux, SDXL, and SD 1.5 are
recognised by file name and get sensible sampling defaults.

Qwen-Image 2.1 is also the reference-based editor: in From image mode attached images go to
the model as references at up to full resolution (garment transfer, virtual try-on), which is
why it holds cut and color fidelity so well.

## Setup from scratch

```bash
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git comfyui
git clone --depth 1 https://github.com/city96/ComfyUI-GGUF.git comfyui/custom_nodes/ComfyUI-GGUF
cd comfyui && uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -r requirements.txt -r custom_nodes/ComfyUI-GGUF/requirements.txt
cd ../web && pnpm install
```

## GGUF loader patch

Upstream ComfyUI-GGUF (as of its Jan 2026 commit) does not recognise Qwen-Image 2.1 GGUF
files that ship without `general.architecture` metadata. `comfyui/custom_nodes/ComfyUI-GGUF/tools/convert.py`
carries a small local patch adding `ModelQwenImage21` (detects `img_in.weight`,
`txt_in.text_norm.weight`, `modulation.1.weight`). Re-apply it if you re-clone the node.
