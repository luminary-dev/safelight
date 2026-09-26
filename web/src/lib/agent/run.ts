import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import OpenAI from "openai";
import { toAnthropicMessages } from "@/lib/providers/anthropic";
import { toContents } from "@/lib/providers/gemini";
import { OLLAMA_URL } from "@/lib/ollama/client";
import { toOpenAIMessages } from "@/lib/providers/openai";
import { getKey, PROVIDER_META, type ProviderId } from "@/lib/providers/keys";
import { type ChatTurn } from "@/lib/providers/types";
import { executeTool, TOOLS, type ToolContext } from "./tools";

export const AGENT_SYSTEM_PROMPT =
  "You are Safelight, an assistant inside Safelight, a local image app, working in agent mode with tools. " +
  "When the user wants a picture, write a strong visual prompt and call generate_image once (use count for variations). " +
  "When they want a change to an existing picture, call edit_image with the reference of that picture. " +
  "Use list_models only if asked about models or if a render fails for lack of a model; use list_recent_images to find earlier renders. " +
  "After a tool finishes, reply briefly in plain text: what you made and one or two ideas for a next tweak. Never paste image references or JSON into your reply; the images are shown to the user automatically. " +
  "For questions that need no image, just answer normally.";

const MAX_ROUNDS = 8;

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
  const key = await getKey("openai");
  if (!key) throw new Error("No OpenAI API key configured.");
  const client = new OpenAI({ apiKey: key });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: systemOf(ctx) }, ...toOpenAIMessages(turns)];
  const tools: OpenAI.Chat.ChatCompletionTool[] = defsOf(ctx).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await client.chat.completions.create({ model, messages, tools, tool_choice: "auto" }, { signal: ctx.signal });
    const msg = res.choices[0]?.message;
    if (!msg) break;
    if (msg.content) ctx.emit({ type: "text", text: msg.content });
    const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
    if (calls.length === 0) return;
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
    for (const c of calls) {
      const fn = (c as OpenAI.Chat.ChatCompletionMessageFunctionToolCall).function;
      const { payload } = await runTool(fn.name, argsOf(fn.arguments), ctx);
      messages.push({ role: "tool", tool_call_id: c.id, content: payload });
    }
  }
};

// ---------------- Anthropic ----------------
const runAnthropic: Runner = async (turns, model, ctx) => {
  const key = await getKey("anthropic");
  if (!key) throw new Error("No Anthropic API key configured.");
  const client = new Anthropic({ apiKey: key });
  const messages: Anthropic.MessageParam[] = toAnthropicMessages(turns);
  const tools: Anthropic.Tool[] = defsOf(ctx).map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema }));
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await client.messages.create({ model, max_tokens: 4000, system: systemOf(ctx), messages, tools }, { signal: ctx.signal });
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
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      const { ok, payload } = await runTool(u.name, argsOf(u.input), ctx);
      results.push({ type: "tool_result", tool_use_id: u.id, content: payload, is_error: !ok });
    }
    messages.push({ role: "user", content: results });
  }
};

// ---------------- Gemini ----------------
const runGemini: Runner = async (turns, model, ctx) => {
  const key = await getKey("gemini");
  if (!key) throw new Error("No Gemini API key configured.");
  const ai = new GoogleGenAI({ apiKey: key });
  const contents: Content[] = toContents(turns);
  const declarations: FunctionDeclaration[] = defsOf(ctx).map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await ai.models.generateContent({
      model,
      contents,
      config: { systemInstruction: systemOf(ctx), tools: [{ functionDeclarations: declarations }], abortSignal: ctx.signal },
    });
    const parts: Part[] = res.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((p) => p.text)
      .filter(Boolean)
      .join("");
    if (text) ctx.emit({ type: "text", text });
    const calls = res.functionCalls ?? [];
    if (calls.length === 0) return;
    contents.push({ role: "model", parts });
    const responses: Part[] = [];
    for (const c of calls) {
      const name = c.name ?? "";
      const { payload } = await runTool(name, argsOf(c.args), ctx);
      responses.push({ functionResponse: { id: c.id, name, response: JSON.parse(payload) as Record<string, unknown> } });
    }
    contents.push({ role: "user", parts: responses });
  }
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
  for (let round = 0; round < MAX_ROUNDS; round++) {
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
    for (const c of calls) {
      const { payload } = await runTool(c.function.name, argsOf(c.function.arguments), ctx);
      messages.push({ role: "tool", content: payload });
    }
  }
};

export async function runAgent(provider: ProviderId | "ollama", model: string, turns: ChatTurn[], ctx: ToolContext): Promise<void> {
  const runner: Runner = provider === "ollama" ? runOllama : provider === "openai" ? runOpenAI : provider === "anthropic" ? runAnthropic : runGemini;
  if (provider !== "ollama" && !(await getKey(provider))) throw new Error(`No ${PROVIDER_META[provider].label} API key configured.`);
  await runner(turns, model, ctx);
}
