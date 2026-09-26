import type { SystemRow, Tone, TopMode } from "@/components/shell";

/**
 * Pure derivation of the sidebar's system rows and the overall pill from backend health.
 * Kept out of the component tree so it is testable and never re-created per render.
 */

export interface StatusInputs {
  checking: boolean;
  topMode: TopMode;
  online: boolean;
  progressConnected: boolean;
  ollamaUp: boolean;
  localChatCount: number;
  localImageCount: number;
  /** provider → configured key info. */
  keys: { provider: string; configured: boolean; hint?: string }[];
  cloudErrors: Record<string, string> | undefined;
  /** provider → chat model count. */
  chatCounts: Record<string, number>;
  /** provider → image model count. */
  imageCounts: Record<string, number>;
  onAddKey: () => void;
}

const CLOUD_ROWS: { id: string; label: string }[] = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "gemini", label: "Gemini" },
];

function cloudRow(i: StatusInputs, id: string, label: string): SystemRow {
  const k = i.keys.find((x) => x.provider === id);
  const err = i.cloudErrors?.[id];
  const chatN = i.chatCounts[id] ?? 0;
  const imgN = i.imageCounts[id] ?? 0;
  if (!k?.configured) return { id, label, detail: "No key", tone: "off", action: { label: "Add key", onClick: i.onAddKey } };
  if (err) return { id, label, detail: err.replace(/^\d+\s*/, "").slice(0, 60), tone: "down", action: { label: "Fix key", onClick: i.onAddKey } };
  const parts = [chatN ? `${chatN} chat` : null, imgN ? `${imgN} image` : null].filter(Boolean);
  return { id, label, detail: `${parts.join(" · ") || "connected"} · key ${k.hint ?? ""}`.trim(), tone: "ok" };
}

export function deriveStatus(i: StatusInputs): { systems: SystemRow[]; overall: { tone: Tone; label: string } } {
  const systems: SystemRow[] = i.checking
    ? [
        { id: "comfy", label: "ComfyUI", detail: "Checking…", tone: "checking" },
        { id: "ollama", label: "Ollama", detail: "Checking…", tone: "checking" },
      ]
    : [
        i.online
          ? i.progressConnected
            ? { id: "comfy", label: "ComfyUI", detail: `${i.localImageCount} local model${i.localImageCount === 1 ? "" : "s"} · live progress on`, tone: "ok" }
            : { id: "comfy", label: "ComfyUI", detail: "Up · live progress reconnecting", tone: "warn" }
          : { id: "comfy", label: "ComfyUI", detail: "Offline · run pnpm comfy", tone: "down" },
        i.ollamaUp
          ? i.localChatCount
            ? { id: "ollama", label: "Ollama", detail: `${i.localChatCount} local chat model${i.localChatCount === 1 ? "" : "s"}`, tone: "ok" }
            : { id: "ollama", label: "Ollama", detail: "Up · no models pulled", tone: "warn" }
          : { id: "ollama", label: "Ollama", detail: "Offline · run ollama serve", tone: "down" },
        ...CLOUD_ROWS.map((c) => cloudRow(i, c.id, c.label)),
      ];

  const relevant = i.topMode === "image" ? ["comfy", "openai", "gemini"] : ["ollama", "openai", "anthropic", "gemini"];
  const relevantRows = systems.filter((r) => relevant.includes(r.id));
  const overall: { tone: Tone; label: string } = i.checking
    ? { tone: "checking", label: "Checking" }
    : relevantRows.some((r) => r.tone === "ok") && relevantRows.every((r) => r.tone === "ok" || r.tone === "off")
      ? { tone: "ok", label: i.topMode === "image" ? (i.online ? "Ready to render" : "Cloud ready") : "Ready to chat" }
      : relevantRows.some((r) => r.tone === "ok")
        ? { tone: "warn", label: "Partly ready" }
        : { tone: "down", label: i.topMode === "image" ? "Nothing to render with" : "Nothing to chat with" };

  return { systems, overall };
}
