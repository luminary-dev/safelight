import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRunRegistryForTests } from "@/lib/agent/run-registry";
import { resetDbForTests } from "@/lib/db";
import { readStreamText } from "@/test/fakes/http";
import { POST } from "./route";

/**
 * POST /api/design (TEST-BRIEF §8): validation plus the NDJSON stream contract
 * for the design scout, with the Ollama upstream as a scripted fetch stub.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-design-api-"));
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
    new Request("http://localhost:3001/api/design", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }) as unknown as NextRequest,
  );
}

function parseNdjson(text: string): { type: string; [k: string]: unknown }[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string });
}

const BASE = { provider: "ollama", model: "m", messages: [{ role: "user", content: "find me a palette" }] };

describe("POST /api/design", () => {
  it("rejects malformed JSON, a missing model, and an unknown provider with 400", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post({ provider: "ollama" })).status).toBe(400);
    expect((await post({ ...BASE, provider: "skynet" })).status).toBe(400);
  });

  it("streams run-first framed NDJSON with exactly one done, done last", async () => {
    const bodies: { messages: { role: string; content: string }[]; tools?: unknown[] }[] = [];
    vi.stubGlobal("fetch", (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as (typeof bodies)[number]);
      return new Response(JSON.stringify({ message: { role: "assistant", content: "Palette saved." } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    const res = await post(BASE);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const events = parseNdjson(await readStreamText(res.body!));
    expect(events[0].type).toBe("run");
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(events.at(-1)!.type).toBe("done");
    expect(events.some((e) => e.type === "text")).toBe(true);
    // The design toolset was offered to the model.
    expect((bodies[0].tools ?? []).length).toBeGreaterThan(0);
  });

  it("delivers an upstream failure as an error event, not a broken stream", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw new Error("search backend gone");
    }) as typeof fetch);
    const res = await post(BASE);
    const events = parseNdjson(await readStreamText(res.body!));
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(events.at(-1)!.type).toBe("done");
  });
});
