import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "@/lib/agent/run";
import type { AgentEvent, ToolContext } from "@/lib/agent/tools";
import { makeTestDb, type TestDb } from "@/test/fixtures/db";
import { createProviderMsw } from "@/test/msw/providers";
import type { ProviderId } from "./keys";

/**
 * The provider PARITY suite (TEST-BRIEF §6): one scripted two-turn
 * conversation — text → tool call → tool result → text — driven through the
 * REAL agent loop (run.ts) and the REAL provider SDKs against MSW, once per
 * adapter family: openai, anthropic, gemini, and openai-compat (groq).
 *
 * THE INVARIANT, precisely: after dropping `status` events (provider-specific
 * noise: the "run <id>" announcement, retry narration, spend warnings — the
 * only event type an adapter may emit at its own discretion), every adapter
 * must produce the IDENTICAL ordered sequence
 *
 *   text("Scouting.")
 *   tool(get_weather, running,  args {city: "Oslo", days: 2})
 *   tool(get_weather, done,     result {tempC: 7})
 *   text("Done.")
 *
 * with the same parsed args object regardless of the wire encoding (OpenAI
 * ships arguments as a JSON string, Anthropic and Gemini as objects), and the
 * running/done pair sharing one tool id. ChatMode.tsx renders this stream, so
 * a divergent adapter is a UI bug.
 */

const keyed = vi.hoisted(() => new Map<string, string>());

vi.mock("./keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./keys")>();
  return {
    ...actual,
    getKey: async (p: ProviderId) => keyed.get(p),
    getProviderConfig: async (p: ProviderId) => ({ key: keyed.get(p), baseUrl: undefined }),
  };
});

const ARGS = { city: "Oslo", days: 2 };
const rounds = { count: 0 };

/** Non-streaming two-turn scripts. The agent loop uses non-streaming calls, which the harness's SSE handlers do not cover. */
function twoTurnHandlers() {
  const openaiStyle = (base: string) =>
    http.post(`${base}/chat/completions`, () => {
      const first = rounds.count++ === 0;
      return HttpResponse.json({
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 1,
        model: "m",
        choices: [
          {
            index: 0,
            finish_reason: first ? "tool_calls" : "stop",
            message: first
              ? { role: "assistant", content: "Scouting.", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify(ARGS) } }] }
              : { role: "assistant", content: "Done." },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 5 },
      });
    });

  return [
    openaiStyle("https://api.openai.com/v1"),
    openaiStyle("https://api.groq.com/openai/v1"),
    http.post("https://api.anthropic.com/v1/messages", () => {
      const first = rounds.count++ === 0;
      return HttpResponse.json({
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: "m",
        content: first
          ? [
              { type: "text", text: "Scouting." },
              { type: "tool_use", id: "toolu_1", name: "get_weather", input: ARGS },
            ]
          : [{ type: "text", text: "Done." }],
        stop_reason: first ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 5 },
      });
    }),
    http.post("https://generativelanguage.googleapis.com/v1beta/models/*", ({ request }) => {
      if (!new URL(request.url).pathname.includes(":generateContent")) return undefined;
      const first = rounds.count++ === 0;
      return HttpResponse.json({
        candidates: [
          {
            content: {
              role: "model",
              parts: first ? [{ text: "Scouting." }, { functionCall: { name: "get_weather", args: ARGS } }] : [{ text: "Done." }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 },
      });
    }),
  ];
}

const msw = createProviderMsw();
let db: TestDb;

beforeAll(() => msw.server.listen({ onUnhandledRequest: "error" }));
beforeEach(async () => {
  db = await makeTestDb();
  rounds.count = 0;
  keyed.clear();
  msw.server.use(...twoTurnHandlers());
});
afterEach(async () => {
  msw.server.resetHandlers();
  msw.reset();
  await db.cleanup();
});
afterAll(() => msw.server.close());

/** The stub toolset the loop executes: one tool, a deterministic result. */
function stubToolset(executed: { name: string; args: Record<string, unknown> }[]): NonNullable<ToolContext["toolset"]> {
  return {
    defs: [{ name: "get_weather", description: "Weather for a city.", parameters: { type: "object", properties: { city: { type: "string" }, days: { type: "integer" } }, required: ["city"] } }],
    execute: async (name, args) => {
      executed.push({ name, args });
      return { result: { tempC: 7 } };
    },
  };
}

async function runScriptedConversation(provider: ProviderId, key: string, model: string) {
  keyed.set(provider, key);
  const events: AgentEvent[] = [];
  const executed: { name: string; args: Record<string, unknown> }[] = [];
  const out = await runAgent(provider, model, [{ role: "user", content: "weather in Oslo?" }], {
    clientId: "agent",
    toolset: stubToolset(executed),
    emit: (e) => events.push(e),
  });
  return { events, executed, out };
}

/** The provider-neutral event shape every adapter must emit (status noise removed). */
function assertCanonicalShape(events: AgentEvent[], executed: { name: string; args: Record<string, unknown> }[]) {
  const meaningful = events.filter((e) => e.type !== "status");
  expect(meaningful).toEmitAgentEvents([
    { type: "text", text: "Scouting." },
    { type: "tool", name: "get_weather", state: "running", args: ARGS },
    { type: "tool", name: "get_weather", state: "done", args: ARGS, result: { tempC: 7 } },
    { type: "text", text: "Done." },
  ]);
  // The running/done pair is one tool invocation: same id, and it ran exactly once.
  const tools = meaningful.filter((e) => e.type === "tool") as Extract<AgentEvent, { type: "tool" }>[];
  expect(tools[0].id).toBe(tools[1].id);
  expect(executed).toEqual([{ name: "get_weather", args: ARGS }]);
}

const CASES: [string, ProviderId, string, string][] = [
  ["openai", "openai", "sk-test", "gpt-4o"],
  ["anthropic", "anthropic", "sk-ant-test", "claude-sonnet-4-5"],
  ["gemini", "gemini", "AIza-test", "gemini-2.5-pro"],
  ["openai-compat (groq)", "groq", "gsk-test", "llama-3.3-70b-versatile"],
];

describe("agent event parity across provider adapters", () => {
  it.each(CASES)("%s emits the canonical two-turn event sequence", async (_label, provider, key, model) => {
    const { events, executed, out } = await runScriptedConversation(provider, key, model);
    expect(out.status).toBe("done");
    assertCanonicalShape(events, executed);
  });

  it("all four adapters produce byte-identical canonical sequences", async () => {
    const shapes: string[] = [];
    for (const [, provider, key, model] of CASES) {
      rounds.count = 0;
      const { events } = await runScriptedConversation(provider, key, model);
      const canonical = events
        .filter((e) => e.type !== "status")
        .map((e) => (e.type === "tool" ? { type: e.type, name: e.name, args: e.args, state: e.state, result: e.result ?? null } : e));
      shapes.push(JSON.stringify(canonical));
    }
    expect(new Set(shapes).size).toBe(1);
  });
});
