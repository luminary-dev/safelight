import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStreamText } from "@/test/fakes/http";
import { startFakeOllama, type FakeOllama } from "@/test/fakes/ollama-server";

/**
 * /api/chat (TEST-BRIEF §8): the plain-text stream out of the Ollama fake, the
 * per-session system prompt reaching the provider's request body appended to
 * the default, and upstream failures as clean statuses. OLLAMA_URL is captured
 * at import time, so the fake starts before the route module loads.
 */

let ollama: FakeOllama;
let dir: string;
let POST: (req: NextRequest) => Promise<Response>;
let CHAT_SYSTEM_PROMPT: string;
const prevEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-chat-api-"));
  for (const key of ["SAFELIGHT_DATA_DIR", "OLLAMA_URL"]) prevEnv.set(key, process.env[key]);
  process.env.SAFELIGHT_DATA_DIR = dir;
  ollama = await startFakeOllama();
  process.env.OLLAMA_URL = ollama.url;
  ({ POST } = await import("./route"));
  ({ CHAT_SYSTEM_PROMPT } = await import("@/lib/providers/types"));
});

afterAll(async () => {
  await ollama.close();
  for (const [key, value] of prevEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost:3001/api/chat", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }) as unknown as NextRequest,
  );
}

const BASE = { provider: "ollama", model: "llama3:8b", messages: [{ role: "user", content: "hi" }] };

describe("POST /api/chat", () => {
  it("streams the model's text deltas as plain text", async () => {
    ollama.scriptChat(["Hel", "lo", " there."]);
    const res = await post(BASE);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await readStreamText(res.body!)).toBe("Hello there.");
  });

  it("appends the per-session system prompt to the default — it never replaces it", async () => {
    ollama.scriptChat(["ok"]);
    await post({ ...BASE, system: "Always answer in French." });
    const sent = ollama.chatRequests.at(-1)!;
    expect(sent.model).toBe("llama3:8b");
    const system = sent.messages[0] as { role: string; content: string };
    expect(system.role).toBe("system");
    expect(system.content.startsWith(CHAT_SYSTEM_PROMPT)).toBe(true);
    expect(system.content).toContain("Always answer in French.");
    expect((sent.messages[1] as { content: string }).content).toBe("hi");
  });

  it("rejects malformed JSON, a missing model, and an unknown provider with 400", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post({ provider: "ollama", messages: [] })).status).toBe(400);
    expect((await post({ ...BASE, provider: "clippy" })).status).toBe(400);
  });

  it("maps an upstream HTTP failure to 502 with the upstream message, no stack traces", async () => {
    ollama.scriptChat(["irrelevant"], { status: 500 });
    const res = await post(BASE);
    expect(res.status).toBe(502);
    const { error } = (await res.json()) as { error: string };
    expect(error).toBeTruthy();
    expect(error).not.toContain("    at "); // no stack frames in the body
  });

  it("a mid-stream provider error arrives inline as a bracketed marker, not a broken stream", async () => {
    ollama.scriptChat(["partial"], { errorAfter: "model exploded" });
    const res = await post(BASE);
    expect(res.status).toBe(200);
    const text = await readStreamText(res.body!);
    expect(text).toContain("partial");
    expect(text).toContain("[model exploded]");
  });
});
