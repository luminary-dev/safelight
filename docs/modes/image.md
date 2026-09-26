# Image mode

Text-to-image and reference-based editing without a node graph.
Components: `Composer.tsx` + `ImageControls.tsx` (left), `Stage.tsx` (right), orchestrated
by `Safelight.tsx`. Backend: `POST /api/generate` → ComfyUI (graph built per request in
`lib/comfy/graph.ts`) or a cloud image provider.

> **TODO(screenshot):** the composer/stage split with a render in progress.

## The composer (left)

- **Text to image / From image** toggle. From image attaches reference photos (upload, and
  any render via "Edit in Image").
- Model picker grouped by source (local families and cloud), prompt field (⌘⏎ generates),
  aspect and megapixel pills showing the exact pixel size, steps, seed (with lock), batch.
- **More settings** discloses CFG, denoise, negative prompt (noted as ignored at cfg 1 on
  Qwen), sampler, scheduler, text encoders, VAE, and LoRA with strength. Cloud models pick
  their own sampling; size maps to the closest supported aspect ratio.

Selecting a model applies family defaults (`defaultsForModel` in `lib/safelight-state.ts`):
Qwen-Image 25 steps / cfg 1 / euler / simple, Flux 20 / 1 / euler / simple, SDXL 30 / 6 /
dpmpp_2m / karras, SD 1.5 28 / 7 / dpmpp_2m / karras at 512×768. Compatible text encoders
and VAE are picked automatically, and a stale companion (or a LoRA from another model) never
survives a model switch. Every numeric is clamped server-side (`sanitizeRequest` in
`lib/generate-core.ts`).

## The stage (right)

The latest or selected render large, with live progress — stage names ("Loading model",
"Encoding prompt", "Rendering" with step counts) come over a WebSocket to ComfyUI keyed by a
stable per-browser client id, so a page reload still sees progress on an in-flight job.
Below it: a queue strip when more renders are waiting, actions (edit, save, open, delete),
and a filmstrip of earlier renders filtered to **this session** or **everything**. Renders
still running when the page was closed resume polling on the next load. Interrupt cancels
the active ComfyUI job.

## Local vs cloud

Local renders queue on ComfyUI after asking Ollama to unload its resident models (unified
memory is shared; see the README's memory notes). Cloud renders (OpenAI, Gemini) return
directly and are saved to `outputs/cloud/` so they land in the Library like local ones.

## Editing with references

Qwen-Image 2.1 is the reference-based editor: in From image mode attached images go to the
model as references at up to full resolution (garment transfer, virtual try-on), which is why
it holds cut and color fidelity well. Refer to the picture as `<image1>` in the prompt; the
agent's `edit_image` tool does this automatically.

## Sessions

Each image session keeps its render history (up to 100 jobs), current result, and unsent
prompt draft, titled from your first prompt. Deleting a session leaves its images in the
Library.
