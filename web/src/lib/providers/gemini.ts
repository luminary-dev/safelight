import "server-only";
import { GoogleGenAI, Modality, type Content } from "@google/genai";
import type { ChatTurn, CloudChatModel, CloudImageModel, CloudImageRequest, GeneratedImage } from "./types";
import { CHAT_SYSTEM_PROMPT, closestAspect } from "./types";

function client(apiKey: string) {
  return new GoogleGenAI({ apiKey });
}

const IMAGE_MODEL_RE = /image/i;

export async function listGeminiModels(apiKey: string): Promise<{ chat: CloudChatModel[]; images: CloudImageModel[] }> {
  const pager = await client(apiKey).models.list({ config: { pageSize: 200 } });
  const chat: CloudChatModel[] = [];
  const images: CloudImageModel[] = [];
  for await (const m of pager) {
    const name = (m.name ?? "").replace(/^models\//, "");
    if (!name.startsWith("gemini")) continue;
    const actions = m.supportedActions ?? [];
    if (!actions.includes("generateContent")) continue;
    // Skip models that are not plain chat: audio, transcription, robotics, computer use, and the omni/live interaction models.
    if (/embedding|tts|audio|live|native-audio|transcribe|robotics|computer-use|omni|customtools/i.test(name)) continue;
    const label = m.displayName ?? name;
    if (IMAGE_MODEL_RE.test(name)) images.push({ provider: "gemini", id: name, label, edit: true });
    else chat.push({ provider: "gemini", id: name, label });
  }
  return { chat, images };
}

export function toContents(turns: ChatTurn[]): Content[] {
  return turns.map((t) => ({
    role: t.role === "assistant" ? "model" : "user",
    parts: [...(t.images ?? []).map((img) => ({ inlineData: { mimeType: img.mime, data: img.data } })), { text: t.content || (t.images?.length ? "Describe this image." : "") }],
  }));
}

export async function streamGeminiChat(apiKey: string, model: string, turns: ChatTurn[], system: string = CHAT_SYSTEM_PROMPT): Promise<ReadableStream<Uint8Array>> {
  const stream = await client(apiKey).models.generateContentStream({
    model,
    contents: toContents(turns),
    config: { systemInstruction: system },
  });
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          const text = chunk.text;
          if (text) controller.enqueue(encoder.encode(text));
        }
        controller.close();
      } catch (err) {
        controller.enqueue(encoder.encode(`\n[${err instanceof Error ? err.message : "stream error"}]`));
        controller.close();
      }
    },
  });
}

export async function generateGeminiImages(apiKey: string, model: string, req: CloudImageRequest): Promise<GeneratedImage[]> {
  const aspectRatio = closestAspect(req.width, req.height, ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"]);
  const imageSize = Math.max(req.width, req.height) >= 3000 ? "4K" : Math.max(req.width, req.height) >= 1800 ? "2K" : "1K";
  const parts: { text?: string; inlineData?: { data: string; mimeType: string } }[] = [
    ...req.images.map((img) => ({ inlineData: { data: Buffer.from(img.bytes).toString("base64"), mimeType: img.mime } })),
    { text: req.prompt },
  ];
  const out: GeneratedImage[] = [];
  for (let i = 0; i < req.count; i++) {
    const res = await client(apiKey).models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: { responseModalities: [Modality.IMAGE, Modality.TEXT], imageConfig: { aspectRatio, imageSize } },
    });
    const candidateParts = res.candidates?.[0]?.content?.parts ?? [];
    for (const p of candidateParts) {
      if (p.inlineData?.data) out.push({ bytes: Buffer.from(p.inlineData.data, "base64"), mime: p.inlineData.mimeType ?? "image/png" });
    }
    if (out.length === 0) {
      const text = candidateParts.map((p) => p.text).filter(Boolean).join(" ");
      throw new Error(text ? `Gemini returned no image: ${text}` : "Gemini returned no image.");
    }
  }
  return out;
}
