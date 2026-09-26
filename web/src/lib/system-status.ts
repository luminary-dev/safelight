import type { StatusMessage, SystemRow, Tone, TopMode } from "@/components/shell";

/**
 * Pure derivation of the sidebar's system rows and the overall pill from backend health.
 * Kept out of the component tree so it is testable and never re-created per render.
 *
 * i18n: this module returns message KEYS (with ICU values) from the catalog's
 * "systemStatus" namespace instead of English strings; the render site (Sidebar)
 * translates them. Provider labels (ComfyUI, Ollama, OpenAI, …) are product
 * names and stay untranslated.
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
  if (!k?.configured) return { id, label, detail: { key: "noKey" }, tone: "off", action: { label: { key: "addKey" }, onClick: i.onAddKey } };
  if (err) return { id, label, detail: { key: "cloudError", values: { message: err.replace(/^\d+\s*/, "").slice(0, 60) } }, tone: "down", action: { label: { key: "fixKey" }, onClick: i.onAddKey } };
  const hint = k.hint ?? "";
  const detail: StatusMessage =
    chatN && imgN
      ? { key: "cloudOkBoth", values: { chat: chatN, image: imgN, hint } }
      : chatN
        ? { key: "cloudOkChat", values: { chat: chatN, hint } }
        : imgN
          ? { key: "cloudOkImage", values: { image: imgN, hint } }
          : { key: "cloudOkConnected", values: { hint } };
  return { id, label, detail, tone: "ok" };
}

export function deriveStatus(i: StatusInputs): { systems: SystemRow[]; overall: { tone: Tone; label: StatusMessage } } {
  const systems: SystemRow[] = i.checking
    ? [
        { id: "comfy", label: "ComfyUI", detail: { key: "checking" }, tone: "checking" },
        { id: "ollama", label: "Ollama", detail: { key: "checking" }, tone: "checking" },
      ]
    : [
        i.online
          ? i.progressConnected
            ? { id: "comfy", label: "ComfyUI", detail: { key: "comfyOk", values: { count: i.localImageCount } }, tone: "ok" }
            : { id: "comfy", label: "ComfyUI", detail: { key: "comfyReconnecting" }, tone: "warn" }
          : { id: "comfy", label: "ComfyUI", detail: { key: "comfyOffline" }, tone: "down" },
        i.ollamaUp
          ? i.localChatCount
            ? { id: "ollama", label: "Ollama", detail: { key: "ollamaOk", values: { count: i.localChatCount } }, tone: "ok" }
            : { id: "ollama", label: "Ollama", detail: { key: "ollamaNoModels" }, tone: "warn" }
          : { id: "ollama", label: "Ollama", detail: { key: "ollamaOffline" }, tone: "down" },
        ...CLOUD_ROWS.map((c) => cloudRow(i, c.id, c.label)),
      ];

  const renderish = i.topMode === "image" || i.topMode === "blueprints";
  const relevant = renderish ? ["comfy", "openai", "gemini"] : ["ollama", "openai", "anthropic", "gemini"];
  const relevantRows = systems.filter((r) => relevant.includes(r.id));
  const overall: { tone: Tone; label: StatusMessage } = i.checking
    ? { tone: "checking", label: { key: "overallChecking" } }
    : relevantRows.some((r) => r.tone === "ok") && relevantRows.every((r) => r.tone === "ok" || r.tone === "off")
      ? { tone: "ok", label: { key: renderish ? (i.online ? "readyToRender" : "cloudReady") : "readyToChat" } }
      : relevantRows.some((r) => r.tone === "ok")
        ? { tone: "warn", label: { key: "partlyReady" } }
        : { tone: "down", label: { key: renderish ? "nothingToRender" : "nothingToChat" } };

  return { systems, overall };
}
