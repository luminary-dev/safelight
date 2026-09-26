import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeOllama, type FakeOllama } from "@/test/fakes/ollama-server";

/**
 * /api/prompts/enhance (TEST-BRIEF §8): 503 when neither the blueprint nor a
 * local model is available, and the Ollama fallback path. BLUEPRINTS_DIR points
 * at an empty tmpdir (no prompt-enhance blueprint) and COMFY_URL at a port that
 * answers nothing, so only the Ollama leg can succeed.
 */

let ollama: FakeOllama;
let dir: string;
let POST: (req: NextRequest) => Promise<Response>;
const prevEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sl-enhance-api-"));
  for (const key of ["SAFELIGHT_DATA_DIR", "OLLAMA_URL", "COMFY_URL", "BLUEPRINTS_DIR"]) prevEnv.set(key, process.env[key]);
  process.env.SAFELIGHT_DATA_DIR = path.join(dir, "data");
  process.env.BLUEPRINTS_DIR = path.join(dir, "blueprints"); // does not exist → empty registry
  process.env.COMFY_URL = "http://127.0.0.1:9"; // deliberately unreachable
  ollama = await startFakeOllama();
  process.env.OLLAMA_URL = ollama.url;
  ({ POST } = await import("./route"));
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
    new Request("http://localhost:3001/api/prompts/enhance", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }) as unknown as NextRequest,
  );
}

describe("POST /api/prompts/enhance", () => {
  it("rejects malformed JSON and missing text with 400", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ text: "   " })).status).toBe(400);
  });

  it("answers 503 when no blueprint is ready and Ollama has no usable model", async () => {
    ollama.setModels([]);
    const res = await post({ text: "a bird" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/neither is available/);
  });

  it("falls back to the local Ollama chat model and returns its text", async () => {
    ollama.setModels([{ name: "enhance-model:7b", capabilities: ["completion"] }]);
    ollama.scriptChat(["A red-crested bird", " perched on driftwood at golden hour."]);
    const res = await post({ text: "a bird" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; via: string };
    expect(body.via).toBe("ollama");
    expect(body.text).toBe("A red-crested bird perched on driftwood at golden hour.");
    // The system instruction and the user's prompt both reached the model.
    const sent = ollama.chatRequests.at(-1)!;
    expect((sent.messages[0] as { content: string }).content).toMatch(/visual detail/i);
    expect((sent.messages[1] as { content: string }).content).toBe("a bird");
  });

  it("maps a model that returns no text to a 502, not a silent empty enhancement", async () => {
    ollama.setModels([{ name: "enhance-model:7b", capabilities: ["completion"] }]);
    ollama.scriptChat([""]);
    const res = await post({ text: "a bird" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/no text/i);
  });
});
