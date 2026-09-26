import { http, HttpResponse, type HttpHandler } from "msw";
import { setupServer } from "msw/node";
import anthropicModels from "../fixtures/providers/anthropic-models.json";
import anthropicTextEvents from "../fixtures/providers/anthropic-text-events.json";
import anthropicToolEvents from "../fixtures/providers/anthropic-tool-events.json";
import geminiImageResponse from "../fixtures/providers/gemini-image-response.json";
import geminiModels from "../fixtures/providers/gemini-models.json";
import geminiStreamChunks from "../fixtures/providers/gemini-stream-chunks.json";
import groqModels from "../fixtures/providers/groq-models.json";
import openaiChatChunks from "../fixtures/providers/openai-chat-chunks.json";
import openaiImages from "../fixtures/providers/openai-images.json";
import openaiModels from "../fixtures/providers/openai-models.json";
import openaiToolChunks from "../fixtures/providers/openai-tool-chunks.json";
import openrouterModels from "../fixtures/providers/openrouter-models.json";

/**
 * MSW handlers for every cloud provider Safelight speaks to, plus a generic
 * OpenAI-compatible shim for any base URL (Groq, OpenRouter, Mistral, …).
 * The response shapes live in src/test/fixtures/providers/ and were hand-written
 * from the adapters' parsing code in src/lib/providers/* — an SDK upgrade that
 * changes what a wire shape means shows up as a failing self-test here.
 *
 * Scripting API:
 *   const { server, script, reset } = createProviderMsw();
 *   server.listen({ onUnhandledRequest: "bypass" });
 *   script("openai", { chatDeltas: ["Hi", " there"] });          // text stream
 *   script("anthropic", { toolCall: { name: "f", args: {…} } }); // tool-call stream
 *   script("gemini", { chatError: { status: 429, retryAfter: 7 } });
 *   script("openai", { modelsError: { status: 401 } });
 *   reset();                                                     // back to fixtures
 *
 * compatHandlers(baseUrl) returns model-list + chat-stream handlers for any
 * OpenAI-compatible base URL, scripted through the same "compat" key.
 */

export type ScriptedProvider = "openai" | "anthropic" | "gemini" | "groq" | "openrouter" | "compat";

export interface ProviderErrorScript {
  status: 401 | 429 | 500;
  /** Seconds, sent as a Retry-After header (429s should carry one). */
  retryAfter?: number;
}

export interface ProviderScript {
  /** Replaces the fixture's text deltas in the chat stream. */
  chatDeltas?: string[];
  /** Streams a tool call instead of text (OpenAI/compat and Anthropic shapes). */
  toolCall?: { id?: string; name: string; args: Record<string, unknown> };
  chatError?: ProviderErrorScript;
  modelsError?: ProviderErrorScript;
  imagesError?: ProviderErrorScript;
}

type Json = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Splits a tool call's JSON arguments into two streamed fragments. */
function splitArgs(args: Record<string, unknown>): [string, string] {
  const s = JSON.stringify(args);
  const mid = Math.max(1, Math.floor(s.length / 2));
  return [s.slice(0, mid), s.slice(mid)];
}

function errorResponse(provider: ScriptedProvider, err: ProviderErrorScript): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (err.retryAfter !== undefined) headers["retry-after"] = String(err.retryAfter);
  const message = `fake ${provider} scripted ${err.status}`;
  const body: Json =
    provider === "anthropic"
      ? { type: "error", error: { type: err.status === 429 ? "rate_limit_error" : err.status === 401 ? "authentication_error" : "api_error", message } }
      : provider === "gemini"
        ? { error: { code: err.status, message, status: err.status === 429 ? "RESOURCE_EXHAUSTED" : err.status === 401 ? "UNAUTHENTICATED" : "INTERNAL" } }
        : { error: { message, type: err.status === 429 ? "rate_limit_error" : "invalid_request_error", code: null } };
  return HttpResponse.json(body, { status: err.status, headers });
}

// ---------------------------------------------------------------------------
// Stream builders (fixture chunks as templates, deltas swapped in)

function sse(lines: string[]): Response {
  // A ReadableStream body, not a string: the OpenAI SDK's SSE reader hangs on
  // MSW's fixed-length string bodies but consumes a streamed body correctly.
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new HttpResponse(body, { headers: { "content-type": "text/event-stream" } });
}

function openaiStyleStream(deltas: string[] | undefined, toolCall: ProviderScript["toolCall"]): Response {
  let chunks: Json[];
  if (toolCall) {
    chunks = clone(openaiToolChunks) as Json[];
    const [a, b] = splitArgs(toolCall.args);
    type ToolDelta = { choices: { delta: { tool_calls?: { id?: string; function: { name?: string; arguments: string } }[] } }[] };
    (chunks[1] as unknown as ToolDelta).choices[0].delta.tool_calls![0].id = toolCall.id ?? "call_fake1";
    (chunks[1] as unknown as ToolDelta).choices[0].delta.tool_calls![0].function.name = toolCall.name;
    (chunks[2] as unknown as ToolDelta).choices[0].delta.tool_calls![0].function.arguments = a;
    (chunks[3] as unknown as ToolDelta).choices[0].delta.tool_calls![0].function.arguments = b;
  } else {
    const recorded = clone(openaiChatChunks) as Json[];
    const [role, contentTemplate, , finish] = recorded;
    const texts = deltas ?? ["Hello", " world"];
    chunks = [
      role,
      ...texts.map((text) => {
        const c = clone(contentTemplate);
        (c as { choices: { delta: { content: string } }[] }).choices[0].delta.content = text;
        return c;
      }),
      finish,
    ];
  }
  return sse([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"]);
}

function anthropicStream(deltas: string[] | undefined, toolCall: ProviderScript["toolCall"]): Response {
  type NamedEvent = { event: string; data: Json };
  let events: NamedEvent[];
  if (toolCall) {
    events = clone(anthropicToolEvents) as NamedEvent[];
    const start = events[1].data as { content_block: { id: string; name: string } };
    start.content_block.id = toolCall.id ?? "toolu_fake1";
    start.content_block.name = toolCall.name;
    const [a, b] = splitArgs(toolCall.args);
    (events[2].data as { delta: { partial_json: string } }).delta.partial_json = a;
    (events[3].data as { delta: { partial_json: string } }).delta.partial_json = b;
  } else {
    const recorded = clone(anthropicTextEvents) as NamedEvent[];
    const deltaTemplate = recorded[2];
    const texts = deltas ?? ["Hello", " world"];
    events = [
      recorded[0],
      recorded[1],
      ...texts.map((text) => {
        const e = clone(deltaTemplate);
        (e.data as { delta: { text: string } }).delta.text = text;
        return e;
      }),
      ...recorded.slice(4),
    ];
  }
  return sse(events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
}

function geminiStream(deltas: string[] | undefined): Response {
  const recorded = clone(geminiStreamChunks) as Json[];
  let chunks = recorded;
  if (deltas) {
    const [template, last] = [recorded[0], recorded[recorded.length - 1]];
    chunks = deltas.map((text, i) => {
      const c = clone(i === deltas.length - 1 ? last : template);
      (c as { candidates: { content: { parts: { text: string }[] } }[] }).candidates[0].content.parts[0].text = text;
      return c;
    });
  }
  return sse(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`));
}

// ---------------------------------------------------------------------------
// Handlers

export class ProviderScripts {
  private map = new Map<ScriptedProvider, ProviderScript>();
  get(p: ScriptedProvider): ProviderScript {
    return this.map.get(p) ?? {};
  }
  set(p: ScriptedProvider, s: ProviderScript): void {
    this.map.set(p, s);
  }
  reset(): void {
    this.map.clear();
  }
}

/** OpenAI-compatible handlers for any base URL (no trailing slash). */
export function compatHandlers(baseUrl: string, scripts: ProviderScripts, key: ScriptedProvider, modelsFixture: unknown): HttpHandler[] {
  return [
    http.get(`${baseUrl}/models`, () => {
      const s = scripts.get(key);
      if (s.modelsError) return errorResponse(key, s.modelsError);
      return HttpResponse.json(modelsFixture as Json);
    }),
    http.post(`${baseUrl}/chat/completions`, () => {
      const s = scripts.get(key);
      if (s.chatError) return errorResponse(key, s.chatError);
      return openaiStyleStream(s.chatDeltas, s.toolCall);
    }),
  ];
}

export function providerHandlers(scripts: ProviderScripts, opts: { compatBaseUrl?: string } = {}): HttpHandler[] {
  const handlers: HttpHandler[] = [
    // ---- OpenAI ----
    ...compatHandlers("https://api.openai.com/v1", scripts, "openai", openaiModels),
    http.post("https://api.openai.com/v1/images/generations", () => {
      const s = scripts.get("openai");
      if (s.imagesError) return errorResponse("openai", s.imagesError);
      return HttpResponse.json(openaiImages);
    }),
    http.post("https://api.openai.com/v1/images/edits", () => {
      const s = scripts.get("openai");
      if (s.imagesError) return errorResponse("openai", s.imagesError);
      return HttpResponse.json(openaiImages);
    }),

    // ---- Anthropic ----
    http.get("https://api.anthropic.com/v1/models", () => {
      const s = scripts.get("anthropic");
      if (s.modelsError) return errorResponse("anthropic", s.modelsError);
      return HttpResponse.json(anthropicModels);
    }),
    http.post("https://api.anthropic.com/v1/messages", () => {
      const s = scripts.get("anthropic");
      if (s.chatError) return errorResponse("anthropic", s.chatError);
      return anthropicStream(s.chatDeltas, s.toolCall);
    }),

    // ---- Gemini (model paths contain ":" so match with a wildcard) ----
    http.get("https://generativelanguage.googleapis.com/v1beta/models", () => {
      const s = scripts.get("gemini");
      if (s.modelsError) return errorResponse("gemini", s.modelsError);
      return HttpResponse.json(geminiModels);
    }),
    http.post("https://generativelanguage.googleapis.com/v1beta/models/*", ({ request }) => {
      const s = scripts.get("gemini");
      const url = new URL(request.url);
      if (url.pathname.includes(":streamGenerateContent")) {
        if (s.chatError) return errorResponse("gemini", s.chatError);
        return geminiStream(s.chatDeltas);
      }
      if (url.pathname.includes(":generateContent")) {
        if (s.imagesError) return errorResponse("gemini", s.imagesError);
        return HttpResponse.json(geminiImageResponse);
      }
      return HttpResponse.json({ error: { code: 404, message: `no fake for ${url.pathname}` } }, { status: 404 });
    }),

    // ---- OpenAI-compatible providers ----
    ...compatHandlers("https://api.groq.com/openai/v1", scripts, "groq", groqModels),
    ...compatHandlers("https://openrouter.ai/api/v1", scripts, "openrouter", openrouterModels),
  ];
  if (opts.compatBaseUrl) handlers.push(...compatHandlers(opts.compatBaseUrl.replace(/\/$/, ""), scripts, "compat", groqModels));
  return handlers;
}

export interface ProviderMsw {
  server: ReturnType<typeof setupServer>;
  script(provider: ScriptedProvider, script: ProviderScript): void;
  reset(): void;
}

/**
 * One-call setup. The caller owns the lifecycle:
 *   beforeAll(() => msw.server.listen({ onUnhandledRequest: "bypass" }));
 *   afterEach(() => msw.reset());
 *   afterAll(() => msw.server.close());
 * "bypass" keeps the in-process fakes (Comfy, Ollama, page server) reachable.
 */
export function createProviderMsw(opts: { compatBaseUrl?: string } = {}): ProviderMsw {
  const scripts = new ProviderScripts();
  const server = setupServer(...providerHandlers(scripts, opts));
  return {
    server,
    script: (p, s) => scripts.set(p, s),
    reset: () => scripts.reset(),
  };
}
