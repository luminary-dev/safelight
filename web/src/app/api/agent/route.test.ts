import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_SYSTEM_PROMPT } from "@/lib/agent/run";
import { resetRunRegistryForTests } from "@/lib/agent/run-registry";
import { resetDbForTests } from "@/lib/db";
import { readStreamText } from "@/test/fakes/http";
import { POST } from "./route";

/**
 * POST /api/agent (TEST-BRIEF §8, streaming): NDJSON framing — every line
 * parses, the first event is {type:"run"}, exactly one done and done last; an
 * upstream failure arrives as an error event, not a broken stream. The Ollama
 * upstream is a scripted fetch stub (the agent loop speaks non-streaming
 * /api/chat), per the runs-api precedent.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-agent-api-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
  resetRunRegistryForTests();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  resetRunRegistryForTests();
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost:3001/api/agent", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }) as unknown as NextRequest,
  );
}

/** Scripted Ollama: answers /api/chat with one assistant message, recording request bodies. */
function stubOllama(content = "Hello from the agent.") {
  const bodies: { messages: { role: string; content: string }[]; options?: Record<string, number> }[] = [];
  vi.stubGlobal("fetch", (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as (typeof bodies)[number]);
    return new Response(JSON.stringify({ message: { role: "assistant", content } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  return bodies;
}

function parseNdjson(text: string): { type: string; [k: string]: unknown }[] {
  const rawLines = text.split("\n");
  expect(rawLines.at(-1)).toBe(""); // the stream ends with a newline-terminated line
  return rawLines.filter(Boolean).map((l) => JSON.parse(l) as { type: string });
}

const BASE = { provider: "ollama", model: "m", messages: [{ role: "user", content: "hi" }] };

describe("validation", () => {
  it("rejects malformed JSON, a missing model, and an unknown provider with 400", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post({ provider: "ollama" })).status).toBe(400);
    expect((await post({ ...BASE, provider: "skynet" })).status).toBe(400);
  });
});

describe("NDJSON stream", () => {
  it("frames the run correctly: run first, every line parses, exactly one done, done last", async () => {
    stubOllama("The answer.");
    const res = await post(BASE);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const events = parseNdjson(await readStreamText(res.body!));
    expect(events[0].type).toBe("run");
    expect(typeof events[0].id).toBe("string");
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(events.at(-1)!.type).toBe("done");
    expect(events.some((e) => e.type === "text" && e.text === "The answer.")).toBe(true);
  });

  it("appends the per-session system prompt to the default and clamps sampling params", async () => {
    const bodies = stubOllama();
    const res = await post({ ...BASE, system: "Be terse.", params: { temperature: 9, topP: -2, maxTokens: 10.9 } });
    await readStreamText(res.body!);
    const sent = bodies[0];
    const system = sent.messages[0];
    expect(system.role).toBe("system");
    expect(system.content.startsWith(AGENT_SYSTEM_PROMPT)).toBe(true);
    expect(system.content).toContain("Be terse.");
    expect(sent.options).toMatchObject({ temperature: 2, top_p: 0, num_predict: 10 });
  });

  it("delivers an upstream failure as an error event and still ends with a single done", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw new Error("ollama is on fire");
    }) as typeof fetch);
    const res = await post(BASE);
    expect(res.status).toBe(200); // the stream is already committed; the error rides inside it
    const events = parseNdjson(await readStreamText(res.body!));
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(String(error!.message ?? error!.text ?? JSON.stringify(error))).toContain("on fire");
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(events.at(-1)!.type).toBe("done");
  });
});
