import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDetachedRun } from "@/lib/agent/run";
import { getRunEntry, resetRunRegistryForTests } from "@/lib/agent/run-registry";
import { appendEvent, createRun, finishRun, getRun } from "@/lib/agent/runs-store";
import { resetDbForTests } from "@/lib/db";
import type { ChatTurn } from "@/lib/providers/types";
import { POST as STOP } from "./[id]/stop/route";
import { GET as STREAM } from "./[id]/stream/route";
import { GET as LIST } from "./route";

/**
 * The detach/re-attach/stop contract end to end at the route level: the NDJSON
 * response is only a view onto a registry-backed run, GET .../stream replays the
 * persisted log and joins live, and POST .../stop is what actually cancels.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-runs-api-"));
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

const TURNS: ChatTurn[] = [{ role: "user", content: "hi" }];

function req(url: string, init?: RequestInit): NextRequest {
  return new Request(`http://localhost:3001${url}`, init) as unknown as NextRequest;
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function lines(text: string): { type: string; [k: string]: unknown }[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string });
}

async function untilDone(id: string, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!getRunEntry(id)?.done) {
    if (Date.now() - t0 > ms) throw new Error(`run ${id} did not finish in ${ms}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Ollama stub whose reply the test releases when it chooses. */
function deferredOllama(): { release: (content: string) => void } {
  let release!: (r: Response) => void;
  vi.stubGlobal("fetch", (_url: unknown) => new Promise<Response>((res) => (release = res)));
  return {
    release: (content: string) => release(new Response(JSON.stringify({ message: { role: "assistant", content } }), { status: 200, headers: { "content-type": "application/json" } })),
  };
}

describe("GET /api/runs?activeFor", () => {
  it("returns the live run for a client id, and null once it finished", async () => {
    const ollama = deferredOllama();
    const id = startDetachedRun("ollama", "m", TURNS, { clientId: "browser#s1" });
    await new Promise((r) => setTimeout(r, 10));
    const live = (await (await LIST(req("/api/runs?activeFor=browser%23s1"))).json()) as { run: { id: string; provider: string } | null };
    expect(live.run).toMatchObject({ id, provider: "ollama" });
    expect(((await (await LIST(req("/api/runs?activeFor=other"))).json()) as { run: unknown }).run).toBeNull();
    ollama.release("done!");
    await untilDone(id);
    expect(((await (await LIST(req("/api/runs?activeFor=browser%23s1"))).json()) as { run: unknown }).run).toBeNull();
    // The plain listing still works.
    const all = (await (await LIST(req("/api/runs"))).json()) as { runs: { id: string }[] };
    expect(all.runs.map((r) => r.id)).toContain(id);
  });
});

describe("POST /api/runs/[id]/stop", () => {
  it("404s on unknown runs and actually cancels a live one", async () => {
    expect((await STOP(req("/api/runs/nope/stop", { method: "POST" }), params("nope"))).status).toBe(404);

    vi.stubGlobal(
      "fetch",
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_res, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    const id = startDetachedRun("ollama", "m", TURNS, { clientId: "c" });
    await new Promise((r) => setTimeout(r, 10));
    const res = await STOP(req(`/api/runs/${id}/stop`, { method: "POST" }), params(id));
    expect(res.status).toBe(200);
    await untilDone(id);
    expect(getRun(id)!.run.status).toBe("stopped");
    expect(((await (await STOP(req(`/api/runs/${id}/stop`, { method: "POST" }), params(id))).json()) as { alreadyFinished: boolean }).alreadyFinished).toBe(true);
  });
});

describe("GET /api/runs/[id]/stream", () => {
  it("404s when the run is unknown everywhere", async () => {
    expect((await STREAM(req("/api/runs/nope/stream"), params("nope"))).status).toBe(404);
  });

  it("replays a finished run's full log from ?from and ends with done", async () => {
    createRun({ id: "r1", clientId: "c", mode: "agent", provider: "ollama", model: "m" });
    appendEvent("r1", 0, { type: "status", text: "run r1" });
    appendEvent("r1", 1, { type: "text", text: "hello" });
    finishRun("r1", "done");

    const full = lines(await (await STREAM(req("/api/runs/r1/stream?from=0"), params("r1"))).text());
    expect(full).toEqual([{ type: "run", id: "r1" }, { type: "status", text: "run r1" }, { type: "text", text: "hello" }, { type: "done" }]);

    const tail = lines(await (await STREAM(req("/api/runs/r1/stream?from=1"), params("r1"))).text());
    expect(tail).toEqual([{ type: "run", id: "r1" }, { type: "text", text: "hello" }, { type: "done" }]);
  });

  it("re-attaches to a LIVE run: replays the persisted prefix, then streams the rest live", async () => {
    const ollama = deferredOllama();
    const id = startDetachedRun("ollama", "m", TURNS, { clientId: "c" });
    await new Promise((r) => setTimeout(r, 10)); // "run <id>" status is persisted; the loop hangs at the provider

    const res = await STREAM(req(`/api/runs/${id}/stream?from=0`), params(id));
    expect(res.status).toBe(200);
    const textPromise = res.text(); // resolves only when the run ends the stream
    ollama.release("late reply");
    const events = lines(await textPromise);
    expect(events).toEqual([
      { type: "run", id },
      { type: "status", text: `run ${id}` }, // replayed from the DB
      { type: "text", text: "late reply" }, // received live
      { type: "done" },
    ]);
    await untilDone(id);
  });
});
