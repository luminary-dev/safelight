import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import OpenAI from "openai";
import { toAnthropicMessages } from "@/lib/providers/anthropic";
import { toContents } from "@/lib/providers/gemini";
import { OLLAMA_URL } from "@/lib/ollama/client";
import { toOpenAIMessages } from "@/lib/providers/openai";
import { getKey, getProviderConfig, PROVIDER_META, type ProviderId } from "@/lib/providers/keys";
import { type ChatTurn } from "@/lib/providers/types";
import { executeTool, TOOLS, type ToolContext } from "./tools";

export const AGENT_SYSTEM_PROMPT =
  "You are Safelight, an assistant inside Safelight, a local image app, working in agent mode with tools. " +
  "When the user wants a picture, write a strong visual prompt and call generate_image once (use count for variations). " +
  "When they want a change to an existing picture, call edit_image with the reference of that picture. " +
  "Use list_models only if asked about models or if a render fails for lack of a model; use list_recent_images to find earlier renders. " +
  "After a tool finishes, reply briefly in plain text: what you made and one or two ideas for a next tweak. Never paste image references or JSON into your reply; the images are shown to the user automatically. " +
  "For questions that need no image, just answer normally.";

const DEFAULT_MAX_ROUNDS = 24;

function maxRounds(ctx: ToolContext): number {
  return Math.max(1, Math.min(200, ctx.budget?.maxRounds ?? DEFAULT_MAX_ROUNDS));
}

const RETRYABLE = new Set([429, 500, 502, 503, 529]);

/** Retries transient provider failures with backoff, narrating the wait as status events. */
async function withRetries<T>(ctx: ToolContext, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      ctx.emit({ type: "status", text: `Provider busy — retrying (${attempt}/3)…` });
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number; response?: { status?: number } }).status ?? (err as { response?: { status?: number } }).response?.status;
      if (ctx.signal?.aborted || !status || !RETRYABLE.has(status)) throw err;
    }
  }
  throw lastErr;
}

/** Independent tool calls in one turn run concurrently; results come back in call order. */
function runTools(calls: { name: string; args: Record<string, unknown> }[], ctx: ToolContext) {
  return Promise.all(calls.map((c) => runTool(c.name, c.args, ctx)));
}

type Runner = (turns: ChatTurn[], model: string, ctx: ToolContext) => Promise<void>;

function argsOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function defsOf(ctx: ToolContext) {
  return ctx.toolset?.defs ?? TOOLS;
}

function systemOf(ctx: ToolContext) {
  return ctx.systemPrompt ?? AGENT_SYSTEM_PROMPT;
}

async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ id: string; ok: boolean; payload: string }> {
  const id = crypto.randomUUID();
  ctx.emit({ type: "tool", id, name, args, state: "running" });
  try {
    const { result, images, note } = await (ctx.toolset?.execute ?? executeTool)(name, args, ctx, id);
    ctx.emit({ type: "tool", id, name, args, state: "done", result, images, note });
    return { id, ok: true, payload: JSON.stringify(result) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool failed.";
    ctx.emit({ type: "tool", id, name, args, state: "error", note: message });
    return { id, ok: false, payload: JSON.stringify({ error: message }) };
  }
}

// ---------------- OpenAI ----------------
const runOpenAI: Runner = async (turns, model, ctx) => {
  const { key, baseUrl } = await getProviderConfig("openai");
  if (!key) throw new Error("No OpenAI API key configured.");
  const client = new OpenAI({ apiKey: key, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: systemOf(ctx) }, ...toOpenAIMessages(turns)];
  const tools: OpenAI.Chat.ChatCompletionTool[] = defsOf(ctx).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  for (let round = 0; round < maxRounds(ctx); round++) {
    const res = await withRetries(ctx, () => client.chat.completions.create({ model, messages, tools, tool_choice: "auto" }, { signal: ctx.signal }));
    const msg = res.choices[0]?.message;
    if (!msg) break;
    if (msg.content) ctx.emit({ type: "text", text: msg.content });
    const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
    if (calls.length === 0) return;
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
    const fns = calls.map((c) => (c as OpenAI.Chat.ChatCompletionMessageFunctionToolCall).function);
    const results = await runTools(fns.map((fn) => ({ name: fn.name, args: argsOf(fn.arguments) })), ctx);
    calls.forEach((c, i) => messages.push({ role: "tool", tool_call_id: c.id, content: results[i].payload }));
  }
  ctx.emit({ type: "status", text: "Stopped: the run reached its round budget." });
};

// ---------------- Anthropic ----------------
const runAnthropic: Runner = async (turns, model, ctx) => {
  const { key, baseUrl } = await getProviderConfig("anthropic");
  if (!key) throw new Error("No Anthropic API key configured.");
  const client = new Anthropic({ apiKey: key, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  const messages: Anthropic.MessageParam[] = toAnthropicMessages(turns);
  const tools: Anthropic.Tool[] = defsOf(ctx).map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema }));
  for (let round = 0; round < maxRounds(ctx); round++) {
    const res = await withRetries(ctx, () => client.messages.create({ model, max_tokens: 4000, system: systemOf(ctx), messages, tools }, { signal: ctx.signal }));
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text) ctx.emit({ type: "text", text });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (res.stop_reason === "refusal") {
      ctx.emit({ type: "text", text: "The model declined this request." });
      return;
    }
    if (uses.length === 0) return;
    messages.push({ role: "assistant", content: res.content });
    const outcomes = await runTools(uses.map((u) => ({ name: u.name, args: argsOf(u.input) })), ctx);
    messages.push({ role: "user", content: uses.map((u, i): Anthropic.ToolResultBlockParam => ({ type: "tool_result", tool_use_id: u.id, content: outcomes[i].payload, is_error: !outcomes[i].ok })) });
  }
  ctx.emit({ type: "status", text: "Stopped: the run reached its round budget." });
};

// ---------------- Gemini ----------------
const runGemini: Runner = async (turns, model, ctx) => {
  const { key, baseUrl } = await getProviderConfig("gemini");
  if (!key) throw new Error("No Gemini API key configured.");
  const ai = new GoogleGenAI({ apiKey: key, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
  const contents: Content[] = toContents(turns);
  const declarations: FunctionDeclaration[] = defsOf(ctx).map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));
  for (let round = 0; round < maxRounds(ctx); round++) {
    const res = await withRetries(ctx, () => ai.models.generateContent({
      model,
      contents,
      config: { systemInstruction: systemOf(ctx), tools: [{ functionDeclarations: declarations }], abortSignal: ctx.signal },
    }));
    const parts: Part[] = res.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((p) => p.text)
      .filter(Boolean)
      .join("");
    if (text) ctx.emit({ type: "text", text });
    const calls = res.functionCalls ?? [];
    if (calls.length === 0) return;
    contents.push({ role: "model", parts });
    const outcomes = await runTools(calls.map((c) => ({ name: c.name ?? "", args: argsOf(c.args) })), ctx);
    contents.push({ role: "user", parts: calls.map((c, i): Part => ({ functionResponse: { id: c.id, name: c.name ?? "", response: JSON.parse(outcomes[i].payload) as Record<string, unknown> } })) });
  }
  ctx.emit({ type: "status", text: "Stopped: the run reached its round budget." });
};

// ---------------- Ollama ----------------
interface OllamaChatResponse {
  message?: { role: string; content?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> | string } }[] };
  error?: string;
}

const runOllama: Runner = async (turns, model, ctx) => {
  const messages: { role: string; content: string; images?: string[]; tool_calls?: unknown }[] = [
    { role: "system", content: systemOf(ctx) },
    ...turns.map((t) => ({ role: t.role, content: t.content, images: t.images?.map((i) => i.data) })),
  ];
  const tools = defsOf(ctx).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  for (let round = 0; round < maxRounds(ctx); round++) {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, tools, stream: false }),
      signal: ctx.signal,
    });
    const data = (await res.json().catch(() => ({}))) as OllamaChatResponse;
    if (!res.ok || data.error) {
      const msg = data.error ?? `Ollama returned ${res.status}`;
      if (/does not support tools/i.test(msg)) throw new Error(`${model} does not support tool calling. Pick a cloud model or a tool-capable Ollama model such as llama3.1 or qwen2.5.`);
      throw new Error(msg);
    }
    const msg = data.message;
    if (!msg) break;
    if (msg.content) ctx.emit({ type: "text", text: msg.content });
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) return;
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    const outcomes = await runTools(calls.map((c) => ({ name: c.function.name, args: argsOf(c.function.arguments) })), ctx);
    for (const o of outcomes) messages.push({ role: "tool", content: o.payload });
  }
  ctx.emit({ type: "status", text: "Stopped: the run reached its round budget." });
};

export async function runAgent(provider: ProviderId | "ollama", model: string, turns: ChatTurn[], ctx: ToolContext): Promise<void> {
  const runner: Runner = provider === "ollama" ? runOllama : provider === "openai" ? runOpenAI : provider === "anthropic" ? runAnthropic : runGemini;
  if (provider !== "ollama" && !(await getKey(provider))) throw new Error(`No ${PROVIDER_META[provider].label} API key configured.`);
  await runner(turns, model, ctx);
}
