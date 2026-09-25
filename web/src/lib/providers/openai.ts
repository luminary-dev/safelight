import "server-only";
import OpenAI, { toFile } from "openai";
import type { ChatTurn, CloudChatModel, CloudImageModel, CloudImageRequest, GeneratedImage } from "./types";
import { CHAT_SYSTEM_PROMPT } from "./types";

function client(apiKey: string) {
  return new OpenAI({ apiKey });
}

const IMAGE_MODEL_RE = /^(gpt-image|dall-e|chatgpt-image)/;
const CHAT_MODEL_RE = /^(gpt-|o[1-9]|chatgpt-)/;
// Drop dated snapshots, previews, legacy 3.5 / 4-turbo variants, and non-chat modalities so the picker stays short.
const CHAT_EXCLUDE_RE = /(audio|realtime|transcribe|tts|search|image|embedding|moderation|instruct|codex|preview|live|gpt-3\.5|gpt-4-turbo|gpt-4-\d|gpt-4$|16k|32k|-\d{4}$|-\d{4}-\d{2}-\d{2}$|-latest$)/;

export async function listOpenAIModels(apiKey: string): Promise<{ chat: CloudChatModel[]; images: CloudImageModel[] }> {
  const page = await client(apiKey).models.list();
  const ids: string[] = [];
  for await (const m of page) ids.push(m.id);
  ids.sort();
  const chat = ids
    .filter((id) => CHAT_MODEL_RE.test(id) && !CHAT_EXCLUDE_RE.test(id))
    .map((id) => ({ provider: "openai" as const, id, label: id }));
  const images = ids
    .filter((id) => IMAGE_MODEL_RE.test(id) && !/\d{4}-\d{2}-\d{2}/.test(id) && !/dall-e-2/.test(id))
    .map((id) => ({ provider: "openai" as const, id, label: id, edit: !/dall-e/.test(id) }));
  return { chat, images };
}

export function toOpenAIMessages(turns: ChatTurn[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return turns.map((t) => {
    if (t.role === "assistant") return { role: "assistant", content: t.content };
    if (!t.images?.length) return { role: "user", content: t.content };
    return {
      role: "user",
      content: [
        ...t.images.map((img) => ({ type: "image_url" as const, image_url: { url: `data:${img.mime};base64,${img.data}`, detail: "high" as const } })),
        { type: "text" as const, text: t.content || "Describe this image." },
      ],
    };
  });
}

export async function streamOpenAIChat(apiKey: string, model: string, turns: ChatTurn[], signal?: AbortSignal, system: string = CHAT_SYSTEM_PROMPT): Promise<ReadableStream<Uint8Array>> {
  const stream = await client(apiKey).chat.completions.create(
    {
      model,
      stream: true,
      messages: [{ role: "system", content: system }, ...toOpenAIMessages(turns)],
    },
    { signal },
  );
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) controller.enqueue(encoder.encode(delta));
        }
        controller.close();
      } catch (err) {
        controller.enqueue(encoder.encode(`\n[${err instanceof Error ? err.message : "stream error"}]`));
        controller.close();
      }
    },
  });
}

function openAISize(width: number, height: number, model: string): "1024x1024" | "1536x1024" | "1024x1536" | "1792x1024" | "1024x1792" {
  const ratio = width / height;
  if (/dall-e-3/.test(model)) return ratio > 1.2 ? "1792x1024" : ratio < 0.83 ? "1024x1792" : "1024x1024";
  return ratio > 1.2 ? "1536x1024" : ratio < 0.83 ? "1024x1536" : "1024x1024";
}

export async function generateOpenAIImages(apiKey: string, model: string, req: CloudImageRequest): Promise<GeneratedImage[]> {
  const c = client(apiKey);
  const size = openAISize(req.width, req.height, model);
  const isGptImage = /gpt-image|chatgpt-image/.test(model);
  const count = /dall-e-3/.test(model) ? 1 : req.count;

  let data: { b64_json?: string; url?: string }[] | undefined;
  if (req.images.length > 0) {
    const files = await Promise.all(req.images.map((img) => toFile(Buffer.from(img.bytes), img.name, { type: img.mime })));
    const res = await c.images.edit({
      model,
      prompt: req.prompt,
      image: files.length === 1 ? files[0] : files,
      n: count,
      size,
      ...(isGptImage ? {} : { response_format: "b64_json" as const }),
    });
    data = res.data;
  } else {
    const res = await c.images.generate({
      model,
      prompt: req.prompt,
      n: count,
      size,
      ...(isGptImage ? {} : { response_format: "b64_json" as const }),
    });
    data = res.data;
  }

  const out: GeneratedImage[] = [];
  for (const item of data ?? []) {
    if (item.b64_json) out.push({ bytes: Buffer.from(item.b64_json, "base64"), mime: "image/png" });
    else if (item.url) {
      const r = await fetch(item.url);
      out.push({ bytes: new Uint8Array(await r.arrayBuffer()), mime: r.headers.get("content-type") ?? "image/png" });
    }
  }
  return out;
}
