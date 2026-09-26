# Chat mode

A first-class conversation surface over local and cloud models.
Component: `web/src/components/ChatWorkspace.tsx` → the shared `ChatMode.tsx` engine.
Backend: `POST /api/chat` (plain streamed text) or `POST /api/agent` (NDJSON tool loop) when
Agent is on.

> **TODO(screenshot):** Chat mode with a markdown reply and the agent toggle.

## Models

The picker groups models by source: **Local (Ollama)**, OpenAI, Anthropic, Gemini. Ollama
models are listed with tags for parameter size, quantisation, and `vision` (reported by
Ollama's `/api/show`); cloud models appear once their key is configured. Each chat session
remembers its own model.

## Replies

Assistant replies render as markdown (GFM) with syntax-highlighted, copy-buttoned code
blocks and tables. While streaming there is a **Stop** button; the last reply has
**Regenerate**, and every reply has **Copy** on hover.

## Attachments and vision

Attach up to six images with the paperclip, by dropping them on the composer, or by pasting.
They upload into the same `inputs/` folder Image mode uses, so a reference can flow straight
into a render. Models without vision are flagged and the send button is disabled while an
image is attached.

## Cross-mode handoffs

Hover a reply for:

- **Use as image prompt** — fills the Image-mode prompt (and negative prompt when the reply
  follows a `Prompt: / Negative prompt:` structure) and switches to Image mode.
- **Use with the photo as reference** — additionally switches to From image with the last
  attached photo as image 1.

## Agent mode

Toggle **Agent** next to the model picker. The model gains the studio toolset
(`generate_image`, `edit_image`, `list_models`, `list_recent_images`) and its tool activity
renders as cards in the reply with the resulting images; each image has an "Edit in Image"
shortcut. It renders with the model currently selected in Image mode unless it picks another.
Local renders block the agent until ComfyUI finishes — the card shows elapsed time, and
expect minutes per image on a laptop. Requires a tool-capable model; others get a clear
error. See [../agents-and-tools.md](../agents-and-tools.md).

## Sessions

Each chat keeps its own messages and model, titled automatically from your first message.
Sessions are stored in SQLite (`data/safelight.db`), survive browser resets, and can be
filed into projects from the sidebar.
