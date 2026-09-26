import { mkdirSync, writeFileSync } from "node:fs";
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
 * POST /api/code (TEST-BRIEF §8): the workspace-root validation table
 * (non-absolute / filesystem root / missing / a file → 400) and the NDJSON
 * stream contract, with the Ollama upstream as a scripted fetch stub.
 */

let dir: string;
let workspace: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-code-api-"));
  workspace = path.join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(dir, "a-file.txt"), "not a folder");
  process.env.SAFELIGHT_DATA_DIR = path.join(dir, "data");
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
    new Request("http://localhost:3001/api/code", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }) as unknown as NextRequest,
  );
}

function stubOllama(content = "Edit applied.") {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  vi.stubGlobal("fetch", (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as (typeof bodies)[number]);
    return new Response(JSON.stringify({ message: { role: "assistant", content } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  return bodies;
}

function parseNdjson(text: string): { type: string; [k: string]: unknown }[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string });
}

const BASE = { provider: "ollama", model: "m", messages: [{ role: "user", content: "fix the bug" }] };

describe("workspace root validation", () => {
  it("refuses every bad root with 400: non-absolute, fs root, missing, a plain file", async () => {
    const table: [unknown, RegExp][] = [
      [undefined, /workspace folder/i],
      ["", /workspace folder/i],
      ["relative/path", /absolute/i],
      ["/", /whole disk/i],
      [path.join(dir, "does-not-exist"), /does not exist/i],
      [path.join(dir, "a-file.txt"), /does not exist/i],
    ];
    for (const [root, message] of table) {
      const res = await post({ ...BASE, root });
      expect(res.status, `root=${String(root)}`).toBe(400);
      expect(((await res.json()) as { error: string }).error, `root=${String(root)}`).toMatch(message);
    }
  });

  it("rejects malformed JSON, a missing model, and an unknown provider with 400", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post({ provider: "ollama", root: workspace })).status).toBe(400);
    expect((await post({ ...BASE, root: workspace, provider: "skynet" })).status).toBe(400);
  });
});

describe("NDJSON stream", () => {
  it("streams run-first framed events over the workspace with one done, done last", async () => {
    const bodies = stubOllama("Done editing.");
    const res = await post({ ...BASE, root: workspace });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const events = parseNdjson(await readStreamText(res.body!));
    expect(events[0].type).toBe("run");
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(events.at(-1)!.type).toBe("done");
    expect(events.some((e) => e.type === "text" && e.text === "Done editing.")).toBe(true);
    // The coding system prompt carries the workspace root to the model.
    expect(bodies[0].messages[0].role).toBe("system");
    expect(bodies[0].messages[0].content).toContain(workspace);
  });

  it("delivers an upstream failure as an error event, not a broken stream", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw new Error("provider melted");
    }) as typeof fetch);
    const res = await post({ ...BASE, root: workspace });
    const events = parseNdjson(await readStreamText(res.body!));
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.at(-1)!.type).toBe("done");
  });
});
