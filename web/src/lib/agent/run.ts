import "server-only";
import { assertOutboundAllowed } from "@/lib/privacy";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import OpenAI from "openai";
import { toAnthropicMessages } from "@/lib/providers/anthropic";
import { toContents } from "@/lib/providers/gemini";
import { OLLAMA_URL } from "@/lib/ollama/client";
import { toOpenAIMessages } from "@/lib/providers/openai";
import { getKey, getProviderConfig, PROVIDER_META, PROVIDERS, type ProviderId } from "@/lib/providers/keys";
import { type ChatTurn } from "@/lib/providers/types";
import { getLogger } from "@/lib/log";
import { checkSpendLimits } from "@/lib/usage/limits";
import { recordUsage } from "@/lib/usage/record";
import { completeRun, publishRunEvent, registerRun, subscribeRun, type RunSubscriber } from "./run-registry";
import { appendEvent, createRun, finishRun, type RunStatus } from "./runs-store";
import { withNotesTools } from "./project-notes";
import { isSubAgentClient, withDelegateTool } from "./subagent";
import { executeTool, TOOLS, type AgentEvent, type ToolContext } from "./tools";

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

// ---------------- Run bookkeeping (persistence, ledger, spend gate) ----------------
// Everything in this section is best-effort write-through: a DB hiccup must never
// kill a render, so every store call is wrapped and failures degrade to a log line.

/** Internal run state rides along on the ToolContext without widening its public type. */
const RUN_META = Symbol("safelight.runMeta");

interface RunMeta {
  id: string;
  mode: string;
  seq: number;
  persist: boolean;
  warnedSpend: boolean;
  stoppedBySpendLimit: boolean;
}

type LoopCtx = ToolContext & { [RUN_META]?: RunMeta };

function metaOf(ctx: ToolContext): RunMeta | undefined {
  return (ctx as LoopCtx)[RUN_META];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Mode for the ledger and the run row, derived from the caller's clientId. */
function modeOf(clientId: string): string {
  if (/design/i.test(clientId)) return "design";
  if (/code/i.test(clientId)) return "code";
  return "agent";
}

/** Records one provider round in the cost ledger. Never throws. */
function recordRound(ctx: ToolContext, provider: string, model: string, usage: { inputTokens?: number; outputTokens?: number; providerCost?: number }, durationMs: number) {
  const meta = metaOf(ctx);
  recordUsage({ provider, model, mode: meta?.mode ?? modeOf(ctx.clientId), durationMs, ...usage });
}

/**
 * Spend-limit gate, checked before every provider round. Hard limit ⇒ emit a
 * clear stop status and end the run; soft limit ⇒ one warning per run.
 * Local providers never count and are never gated.
 */
function gateSpend(ctx: ToolContext, provider: string): boolean {
  if (provider === "ollama") return true;
  const meta = metaOf(ctx);
  try {
    // Global limits plus this provider's own spendLimit:<provider>:* keys.
    const gate = checkSpendLimits(Date.now(), provider);
    if (gate.stop) {
      if (meta) meta.stoppedBySpendLimit = true;
      ctx.emit({ type: "status", text: gate.stop });
      getLogger().warn({ runId: meta?.id, spentToday: gate.spentToday, spentThisMonth: gate.spentThisMonth }, "run stopped by spend limit");
      return false;
    }
    if (gate.warn && !(meta?.warnedSpend)) {
      if (meta) meta.warnedSpend = true;
      ctx.emit({ type: "status", text: gate.warn });
    }
  } catch (err) {
    getLogger().warn({ err: errMsg(err) }, "spend limit check failed; letting the round through");
  }
  return true;
}

/** Persists one emitted event; seq stays monotonic even when a write fails. */
function persistEvent(meta: RunMeta, event: AgentEvent) {
  if (!meta.persist) return;
  const seq = meta.seq++;
  try {
    appendEvent(meta.id, seq, event);
  } catch (err) {
    meta.persist = false; // stop hammering a broken DB; the stream to the client is unaffected
    getLogger().warn({ runId: meta.id, err: errMsg(err) }, "event persistence failed; disabling write-through for this run");
  }
}

function safeFinish(meta: RunMeta, status: "done" | "error" | "stopped", error?: string) {
  try {
    finishRun(meta.id, status, error);
  } catch (err) {
    getLogger().warn({ runId: meta.id, err: errMsg(err) }, "could not finalize run row");
  }
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
      getLogger().warn({ runId: metaOf(ctx)?.id, attempt: attempt + 1, status }, "provider call failed; will retry");
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

/** Sampling overrides from the UI; every unset field keeps today's provider default. */
function paramsOf(ctx: ToolContext): NonNullable<ToolContext["params"]> {
  return ctx.params ?? {};
}

/** Renders count in the ledger via the images column: cloud refs carry their provider in the filename. */
function recordImages(ctx: ToolContext, result: unknown, images: { filename: string; subfolder: string }[], durationMs: number) {
  const mode = metaOf(ctx)?.mode ?? modeOf(ctx.clientId);
  // Prefer the raw model identifier (result.modelId) — the pricing table matches on it;
  // result.model stays the friendly label the UI displays.
  const r = result as { model?: unknown; modelId?: unknown } | null;
  const model = typeof r?.modelId === "string" ? r.modelId : typeof r?.model === "string" ? r.model : "image";
  const buckets = new Map<string, number>();
  for (const img of images) {
    const cloud = img.subfolder === "cloud" || img.subfolder.startsWith("cloud/");
    const prefix = img.filename.split(/[_.]/)[0]?.toLowerCase() ?? "";
    const provider = cloud ? ((PROVIDERS as string[]).includes(prefix) ? prefix : "cloud") : "local";
    buckets.set(provider, (buckets.get(provider) ?? 0) + 1);
  }
  for (const [provider, count] of buckets) recordUsage({ provider, model, mode, images: count, durationMs });
}

async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ id: string; ok: boolean; payload: string }> {
  const id = crypto.randomUUID();
  const started = Date.now();
  ctx.emit({ type: "tool", id, name, args, state: "running" });
  try {
    const { result, images, note } = await (ctx.toolset?.execute ?? executeTool)(name, args, ctx, id);
    ctx.emit({ type: "tool", id, name, args, state: "done", result, images, note });
    const ms = Date.now() - started;
    getLogger().info({ runId: metaOf(ctx)?.id, tool: name, ms, ok: true }, "tool finished");
    // Image renders count in the cost ledger; browsing tools that merely reference images do not.
    if (images?.length && (name === "generate_image" || name === "edit_image")) recordImages(ctx, result, images, ms);
    return { id, ok: true, payload: JSON.stringify(result) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool failed.";
    ctx.emit({ type: "tool", id, name, args, state: "error", note: message });
    getLogger().info({ runId: metaOf(ctx)?.id, tool: name, ms: Date.now() - started, ok: false }, "tool failed");
    return { id, ok: false, payload: JSON.stringify({ error: message }) };
  }
}

// ---------------- OpenAI (and OpenAI-compatible: OpenRouter, Groq) ----------------
type OpenAICompatProvider = Exclude<ProviderId, "anthropic" | "gemini">;

const runOpenAI = async (turns: ChatTurn[], model: string, ctx: ToolContext, provider: OpenAICompatProvider = "openai"): Promise<void> => {
  const meta = PROVIDER_META[provider];
  const { key, baseUrl } = await getProviderConfig(provider);
  if (!key) throw new Error(`No ${meta.label} API key configured.`);
  const client = new OpenAI({ apiKey: key, baseURL: baseUrl || meta.defaultBaseUrl });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: systemOf(ctx) }, ...toOpenAIMessages(turns)];
  const tools: OpenAI.Chat.ChatCompletionTool[] = defsOf(ctx).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  // Some models (gpt-5 family) reject temperature, so sampling fields go on the wire only when set.
  const p = paramsOf(ctx);
  const sampling = {
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.topP !== undefined ? { top_p: p.topP } : {}),
    ...(p.maxTokens !== undefined ? { max_completion_tokens: p.maxTokens } : {}),
  };
  for (let round = 0; round < maxRounds(ctx); round++) {
    if (!gateSpend(ctx, provider)) return;
    const t0 = Date.now();
    const res = await withRetries(ctx, () => client.chat.completions.create({ model, messages, tools, tool_choice: "auto", ...sampling }, { signal: ctx.signal }));
    recordRound(
      ctx,
      provider,
      model,
      {
        inputTokens: res.usage?.prompt_tokens,
        outputTokens: res.usage?.completion_tokens,
        // OpenRouter includes the exact charge on the usage object when accounting is on.
        providerCost: provider === "openrouter" ? (res.usage as { cost?: number } | undefined)?.cost : undefined,
      },
      Date.now() - t0,
    );
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
  const p = paramsOf(ctx);
  const sampling = {
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.topP !== undefined ? { top_p: p.topP } : {}),
  };
  for (let round = 0; round < maxRounds(ctx); round++) {
    if (!gateSpend(ctx, "anthropic")) return;
    const t0 = Date.now();
    const res = await withRetries(ctx, () => client.messages.create({ model, max_tokens: p.maxTokens ?? 4000, system: systemOf(ctx), messages, tools, ...sampling }, { signal: ctx.signal }));
    recordRound(ctx, "anthropic", model, { inputTokens: res.usage?.input_tokens, outputTokens: res.usage?.output_tokens }, Date.now() - t0);
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
  const p = paramsOf(ctx);
  const generation = {
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.topP !== undefined ? { topP: p.topP } : {}),
    ...(p.maxTokens !== undefined ? { maxOutputTokens: p.maxTokens } : {}),
  };
  for (let round = 0; round < maxRounds(ctx); round++) {
    if (!gateSpend(ctx, "gemini")) return;
    const t0 = Date.now();
    const res = await withRetries(ctx, () => ai.models.generateContent({
      model,
      contents,
      config: { systemInstruction: systemOf(ctx), tools: [{ functionDeclarations: declarations }], abortSignal: ctx.signal, ...generation },
    }));
    const usage = res.usageMetadata;
    recordRound(ctx, "gemini", model, { inputTokens: usage?.promptTokenCount, outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0) }, Date.now() - t0);
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
  /** Token accounting from Ollama's non-streaming chat response. */
  prompt_eval_count?: number;
  eval_count?: number;
}

const runOllama: Runner = async (turns, model, ctx) => {
  const messages: { role: string; content: string; images?: string[]; tool_calls?: unknown }[] = [
    { role: "system", content: systemOf(ctx) },
    ...turns.map((t) => ({ role: t.role, content: t.content, images: t.images?.map((i) => i.data) })),
  ];
  const tools = defsOf(ctx).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const p = paramsOf(ctx);
  const options = {
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.topP !== undefined ? { top_p: p.topP } : {}),
    ...(p.maxTokens !== undefined ? { num_predict: p.maxTokens } : {}),
  };
  for (let round = 0; round < maxRounds(ctx); round++) {
    const t0 = Date.now();
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, tools, stream: false, ...(Object.keys(options).length > 0 ? { options } : {}) }),
      signal: ctx.signal,
    });
    const data = (await res.json().catch(() => ({}))) as OllamaChatResponse;
    if (!res.ok || data.error) {
      const msg = data.error ?? `Ollama returned ${res.status}`;
      if (/does not support tools/i.test(msg)) throw new Error(`${model} does not support tool calling. Pick a cloud model or a tool-capable Ollama model such as llama3.1 or qwen2.5.`);
      throw new Error(msg);
    }
    // Local models are free; the row still lands so the Usage page can show token volume.
    recordRound(ctx, "ollama", model, { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count }, Date.now() - t0);
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

type Toolset = NonNullable<ToolContext["toolset"]>;

/**
 * Builds the effective toolset for a run, merging extras the same way MCP does
 * (extra defs + fall-through execute):
 * - project-notes tools join WHATEVER toolset is active whenever ctx.projectId is set;
 * - delegate_task joins only override toolsets that are NOT the studio one (its defs
 *   would carry generate_image) and never a sub-agent's own run — depth limit 1.
 *   The api/agent route passes the studio toolset explicitly, so "not studio" is
 *   detected by the defs, not merely by ctx.toolset being set.
 */
function effectiveToolset(provider: ProviderId | "ollama", model: string, ctx: ToolContext): Toolset {
  const base: Toolset = ctx.toolset ?? { defs: TOOLS, execute: executeTool };
  let toolset = base;
  if (ctx.projectId?.trim()) toolset = withNotesTools(toolset, ctx.projectId.trim());
  const isStudio = base.defs.some((d) => d.name === "generate_image");
  if (ctx.toolset && !isStudio && !isSubAgentClient(ctx.clientId)) {
    // Adapt to RunAgentFn's Promise<void>: sub-agent runs keep their own bookkeeping.
    const run = async (p: ProviderId | "ollama", m: string, t: ChatTurn[], c: ToolContext): Promise<void> => {
      await runAgent(p, m, t, c);
    };
    toolset = withDelegateTool(toolset, { provider, model, run });
  }
  return toolset;
}

function dispatch(provider: ProviderId | "ollama", model: string, turns: ChatTurn[], ctx: ToolContext): Promise<void> {
  if (provider === "ollama") return runOllama(turns, model, ctx);
  if (provider === "anthropic") return runAnthropic(turns, model, ctx);
  if (provider === "gemini") return runGemini(turns, model, ctx);
  // openai, openrouter, and groq all speak the OpenAI wire format.
  return runOpenAI(turns, model, ctx, provider);
}

/**
 * Runs the agent loop against one provider, streaming AgentEvents through ctx.emit.
 *
 * Called directly (sub-agents, tests) it owns the run's persistence: it creates
 * the run row, write-throughs every event, and finalizes the row. Called from
 * startDetachedRun (`opts.detached`) the run registry owns persistence instead —
 * the registry keeps one seq counter for loop AND route events (approvals,
 * terminal errors), so this loop must not keep a second one.
 */
export async function runAgent(
  provider: ProviderId | "ollama",
  model: string,
  turns: ChatTurn[],
  ctx: ToolContext,
  opts: { runId?: string; detached?: boolean } = {},
): Promise<{ status: "done" | "stopped" }> {
  if (provider !== "ollama") assertOutboundAllowed("cloud chat");
  if (provider !== "ollama" && !(await getKey(provider))) throw new Error(`No ${PROVIDER_META[provider].label} API key configured.`);
  const log = getLogger();
  const meta: RunMeta = {
    id: opts.runId ?? crypto.randomUUID(),
    mode: modeOf(ctx.clientId),
    seq: 0,
    persist: !opts.detached,
    warnedSpend: false,
    stoppedBySpendLimit: false,
  };
  if (!opts.detached) {
    try {
      createRun({ id: meta.id, clientId: ctx.clientId, mode: meta.mode, provider, model });
    } catch (err) {
      meta.persist = false;
      log.warn({ runId: meta.id, err: errMsg(err) }, "run persistence unavailable; streaming without write-through");
    }
  }
  const loopCtx: LoopCtx = {
    ...ctx,
    toolset: effectiveToolset(provider, model, ctx),
    emit: (event) => {
      persistEvent(meta, event);
      ctx.emit(event);
    },
    [RUN_META]: meta,
  };
  // Surface the id early so a client can resume this run after a reload.
  // Detached runs announce it from startDetachedRun instead, before the loop starts.
  if (!opts.detached) loopCtx.emit({ type: "status", text: `run ${meta.id}` });
  const startedAt = Date.now();
  log.info({ runId: meta.id, mode: meta.mode, provider, model, turns: turns.length }, "agent run started");
  try {
    await dispatch(provider, model, turns, loopCtx);
    const status = meta.stoppedBySpendLimit ? "stopped" : "done";
    if (meta.persist) safeFinish(meta, status);
    log.info({ runId: meta.id, ms: Date.now() - startedAt, status }, "agent run finished");
    return { status };
  } catch (err) {
    const aborted = ctx.signal?.aborted || (err as Error)?.name === "AbortError";
    if (meta.persist) safeFinish(meta, aborted ? "stopped" : "error", aborted ? undefined : errMsg(err));
    log.warn({ runId: meta.id, ms: Date.now() - startedAt, aborted, err: errMsg(err) }, "agent run ended abnormally");
    throw err;
  }
}

// ---------------- Detached runs (registry-backed) ----------------

/** Everything a route knows before a run exists; emit and signal come from the registry. */
export type DetachedRunContext = Omit<ToolContext, "emit" | "signal">;

/**
 * Starts an agent run that is NOT tied to any HTTP request: the run registers in
 * the run registry, every event fans out to subscribers and writes through to the
 * runs store, and the run aborts ONLY via its own controller (stop endpoint or
 * wall-clock cap) — never a request signal. Returns the run id immediately; pass
 * `subscriber` to see every event from the first one.
 */
export function startDetachedRun(
  provider: ProviderId | "ollama",
  model: string,
  turns: ChatTurn[],
  ctx: DetachedRunContext,
  opts: { maxMs?: number; subscriber?: RunSubscriber } = {},
): string {
  const id = crypto.randomUUID();
  const log = getLogger();
  let persist = true;
  try {
    createRun({ id, clientId: ctx.clientId, mode: modeOf(ctx.clientId), provider, model });
  } catch (err) {
    persist = false;
    log.warn({ runId: id, err: errMsg(err) }, "run persistence unavailable; streaming without write-through");
  }
  const entry = registerRun(id, ctx.clientId, { maxMs: opts.maxMs, persist });
  if (opts.subscriber) subscribeRun(id, opts.subscriber);
  const emit = (event: AgentEvent) => publishRunEvent(id, event);
  // Deferred launch: the caller gets the id (and can announce it) before any event fires.
  void Promise.resolve().then(async () => {
    emit({ type: "status", text: `run ${id}` });
    let status: Exclude<RunStatus, "running"> = "done";
    let error: string | undefined;
    try {
      const out = await runAgent(provider, model, turns, { ...ctx, emit, signal: entry.controller.signal }, { runId: id, detached: true });
      status = out.status;
    } catch (err) {
      const aborted = entry.controller.signal.aborted || (err as Error)?.name === "AbortError";
      status = aborted ? "stopped" : "error";
      if (!aborted) {
        error = errMsg(err);
        emit({ type: "error", text: error });
      }
    } finally {
      if (entry.persist) {
        try {
          finishRun(id, status, error);
        } catch (err) {
          log.warn({ runId: id, err: errMsg(err) }, "could not finalize run row");
        }
      }
      completeRun(id, status);
    }
  });
  return id;
}
