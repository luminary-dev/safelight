import { friendlyName } from "@/lib/friendly-names";
import { listOllamaModels } from "@/lib/ollama/client";
import { cloudCatalog } from "@/lib/providers";

export interface ChatModelEntry {
  provider: "ollama" | "openai" | "anthropic" | "gemini";
  id: string;
  label: string;
  tags: string[];
  /** Whether the model accepts image input. Cloud chat models here all do; Ollama reports it per model. */
  vision: boolean;
}

export async function GET() {
  const [ollama, cloud] = await Promise.all([
    listOllamaModels()
      .then((models) => ({ up: true, models }))
      .catch(() => ({ up: false, models: [] })),
    cloudCatalog(),
  ]);
  const local: ChatModelEntry[] = ollama.models.map((m) => {
    const f = friendlyName(m.name, { sourceHint: m.details?.parameter_size ?? "" });
    const tags = [...f.tags];
    if (m.details?.parameter_size && !tags.some((t) => /B$/.test(t))) tags.unshift(m.details.parameter_size);
    if (m.details?.quantization_level && m.details.quantization_level !== "unknown" && !tags.includes(m.details.quantization_level)) tags.push(m.details.quantization_level);
    const vision = (m.capabilities ?? []).includes("vision");
    if (vision) tags.push("vision");
    // Code and Design pickers filter local models on this tag; without it no Ollama model qualifies.
    if ((m.capabilities ?? []).includes("tools")) tags.push("tools");
    return { provider: "ollama", id: m.name, label: f.label, tags, vision };
  });
  const remote: ChatModelEntry[] = cloud.chat.map((m) => ({ provider: m.provider, id: m.id, label: m.label, tags: m.tags, vision: true }));
  return Response.json({ ollamaUp: ollama.up, models: [...local, ...remote], cloudErrors: cloud.errors });
}
