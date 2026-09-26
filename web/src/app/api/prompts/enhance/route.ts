import type { NextRequest } from "next/server";
import { computeStatus, getInstalled } from "@/lib/blueprints/gating";
import { applyInputs } from "@/lib/blueprints/parse";
import { getBlueprint } from "@/lib/blueprints/registry";
import { getHistory, queuePrompt } from "@/lib/comfy/client";
import { listOllamaModels, streamChat } from "@/lib/ollama/client";

/**
 * POST { text }: expands an image prompt with concrete visual detail.
 * Prefers the vendored "Prompt Enhance" blueprint when it is READY (read-only
 * use of the blueprints pipeline); otherwise falls back to the local Ollama
 * chat model. 503 when neither path is available.
 */

const SYSTEM_PROMPT = "Expand this image prompt with concrete visual detail, one paragraph, no preamble.";
const BLUEPRINT_ID = "prompt-enhance";
const POLL_MS = 1500;
const BLUEPRINT_TIMEOUT_MS = 90_000;

/** Pulls the enhanced string out of a finished blueprint job (PreviewAny reports text arrays). */
function historyText(outputs: Record<string, unknown> | undefined): string | null {
  let best: string | null = null;
  for (const node of Object.values(outputs ?? {})) {
    if (!node || typeof node !== "object") continue;
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      for (const entry of value) {
        if (typeof entry === "string" && entry.trim() && (!best || entry.length > best.length)) best = entry.trim();
      }
    }
  }
  return best;
}

async function enhanceViaBlueprint(text: string, clientId: string): Promise<string | null> {
  const parsed = await getBlueprint(BLUEPRINT_ID);
  if (!parsed) return null;
  const installed = await getInstalled();
  if (!installed || computeStatus(parsed.spec, installed).status !== "ready") return null;
  // applyInputs throws when the blueprint demands inputs we cannot supply (e.g. a required image).
  const graph = applyInputs(parsed, { prompt: text });
  const { prompt_id: id } = await queuePrompt(graph, clientId);
  const start = Date.now();
  for (;;) {
    const entry = await getHistory(id);
    if (entry?.status?.completed || entry?.status?.status_str === "error") {
      if (entry.status?.status_str === "error") throw new Error("The Prompt Enhance blueprint failed.");
      const enhanced = historyText(entry.outputs as Record<string, unknown>);
      if (!enhanced) throw new Error("The Prompt Enhance blueprint returned no text.");
      return enhanced;
    }
    if (Date.now() - start > BLUEPRINT_TIMEOUT_MS) throw new Error("Timed out waiting for the Prompt Enhance blueprint.");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function enhanceViaOllama(text: string): Promise<string | null> {
  let models;
  try {
    models = await listOllamaModels();
  } catch {
    return null; // Ollama is not running
  }
  const model = models.find((m) => (m.capabilities ?? []).includes("completion"))?.name ?? models[0]?.name;
  if (!model) return null;
  const stream = await streamChat(model, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: text },
  ]);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  const enhanced = out.trim();
  if (!enhanced) throw new Error("The local chat model returned no text.");
  return enhanced;
}

export async function POST(request: NextRequest) {
  let body: { text?: string; clientId?: string };
  try {
    body = (await request.json()) as { text?: string; clientId?: string };
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: "Pass the prompt text to enhance: { text }." }, { status: 400 });
  const clientId = typeof body.clientId === "string" && body.clientId ? body.clientId : "safelight";

  // 1) The vendored blueprint, when its nodes are all present.
  try {
    const enhanced = await enhanceViaBlueprint(text, clientId);
    if (enhanced) return Response.json({ text: enhanced, via: "blueprint" });
  } catch {
    // The blueprint exists but cannot run (missing required image input, no API key…) — fall back.
  }

  // 2) The local Ollama chat model.
  try {
    const enhanced = await enhanceViaOllama(text);
    if (enhanced) return Response.json({ text: enhanced, via: "ollama" });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Prompt enhance failed." }, { status: 502 });
  }

  return Response.json(
    { error: "Prompt enhance needs the Prompt Enhance blueprint (ComfyUI) or a local Ollama chat model, and neither is available right now." },
    { status: 503 },
  );
}
