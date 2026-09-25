import "server-only";

export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

export interface OllamaModel {
  name: string;
  size: number;
  details?: { parameter_size?: string; quantization_level?: string; family?: string };
  /** From /api/show, e.g. ["completion", "vision", "tools"]. */
  capabilities?: string[];
}

const capabilityCache = new Map<string, string[]>();

export async function listOllamaModels(): Promise<OllamaModel[]> {
  const res = await fetch(`${OLLAMA_URL}/api/tags`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Ollama /api/tags failed with ${res.status}`);
  const data = (await res.json()) as { models?: OllamaModel[] };
  const models = data.models ?? [];
  await Promise.all(
    models.map(async (m) => {
      if (capabilityCache.has(m.name)) {
        m.capabilities = capabilityCache.get(m.name);
        return;
      }
      try {
        const show = await fetch(`${OLLAMA_URL}/api/show`, { method: "POST", body: JSON.stringify({ model: m.name }) });
        const info = (await show.json()) as { capabilities?: string[] };
        m.capabilities = info.capabilities ?? [];
        capabilityCache.set(m.name, m.capabilities);
      } catch {
        m.capabilities = [];
      }
    }),
  );
  return models;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Base64 images for vision-capable models. */
  images?: string[];
}

/** Streams plain-text deltas from Ollama's chat endpoint. */
export async function streamChat(model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Ollama /api/chat failed with ${res.status}`);
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line) as { message?: { content?: string }; error?: string };
            if (obj.error) controller.enqueue(encoder.encode(`\n[${obj.error}]`));
            else if (obj.message?.content) controller.enqueue(encoder.encode(obj.message.content));
          } catch {
            /* partial line, wait for more */
          }
        }
      },
    }),
  );
}

/** Asks Ollama to drop every resident model so a local image render gets the unified memory. Best effort. */
export async function unloadOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/ps`, { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    const names = (data.models ?? []).map((m) => m.name);
    await Promise.all(
      names.map((name) =>
        fetch(`${OLLAMA_URL}/api/generate`, { method: "POST", body: JSON.stringify({ model: name, keep_alive: 0 }) }).catch(() => undefined),
      ),
    );
    return names;
  } catch {
    return [];
  }
}
