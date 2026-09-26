import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelJob, clearPendingQueue, deleteQueued, promoteQueued } from "./client";

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let queueState: { queue_running: unknown[][]; queue_pending: unknown[][] };

/** Fakes just enough of ComfyUI: GET /queue returns queueState, everything else records and returns ok. */
function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  calls.push({ url, init });
  if (url.endsWith("/queue") && (!init?.method || init.method === "GET")) {
    return Promise.resolve(new Response(JSON.stringify(queueState), { status: 200, headers: { "content-type": "application/json" } }));
  }
  if (url.endsWith("/prompt")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { prompt_id?: string };
    return Promise.resolve(new Response(JSON.stringify({ prompt_id: body.prompt_id ?? "generated", number: -1, node_errors: {} }), { status: 200 }));
  }
  return Promise.resolve(new Response("", { status: 200 }));
}

const bodyOf = (c: Call) => JSON.parse(String(c.init?.body ?? "{}"));

beforeEach(() => {
  calls = [];
  queueState = { queue_running: [], queue_pending: [] };
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});
afterEach(() => vi.unstubAllGlobals());

describe("cancelJob", () => {
  it("interrupts a running job with its prompt id", async () => {
    queueState.queue_running = [[0, "run-1", {}, {}]];
    expect(await cancelJob("run-1")).toBe("interrupted");
    const interrupt = calls.find((c) => c.url.endsWith("/interrupt"));
    expect(interrupt).toBeTruthy();
    expect(bodyOf(interrupt!)).toEqual({ prompt_id: "run-1" });
  });

  it("dequeues a pending job via POST /queue {delete}", async () => {
    queueState.queue_pending = [[1, "pend-1", {}, {}]];
    expect(await cancelJob("pend-1")).toBe("dequeued");
    const del = calls.find((c) => c.url.endsWith("/queue") && c.init?.method === "POST");
    expect(bodyOf(del!)).toEqual({ delete: ["pend-1"] });
  });

  it("no-ops for a finished or unknown job", async () => {
    expect(await cancelJob("gone")).toBe("noop");
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(0);
  });
});

describe("deleteQueued / clearPendingQueue", () => {
  it("posts the delete list", async () => {
    await deleteQueued(["a", "b"]);
    expect(bodyOf(calls[0])).toEqual({ delete: ["a", "b"] });
  });

  it("posts clear: true", async () => {
    await clearPendingQueue();
    expect(bodyOf(calls[0])).toEqual({ clear: true });
  });
});

describe("promoteQueued", () => {
  const GRAPH = { "1": { class_type: "KSampler", inputs: {} } };

  it("re-queues a pending job at the front under the same prompt id and client id", async () => {
    queueState.queue_pending = [[5, "pend-9", GRAPH, { client_id: "browser-7" }]];
    // After the delete, the job is gone from the queue.
    const original = queueState;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/queue")) original.queue_pending = [];
      return fakeFetch(url, init);
    });
    expect(await promoteQueued("pend-9")).toBe(true);
    const prompt = calls.find((c) => c.url.endsWith("/prompt"));
    expect(bodyOf(prompt!)).toMatchObject({ prompt: GRAPH, prompt_id: "pend-9", front: true, client_id: "browser-7" });
  });

  it("returns false when the job is not pending", async () => {
    expect(await promoteQueued("nope")).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/prompt"))).toBe(false);
  });

  it("does not re-queue when the job started running in the race window", async () => {
    queueState.queue_pending = [[5, "racy", GRAPH, {}]];
    const original = queueState;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/queue")) {
        original.queue_pending = [];
        original.queue_running = [[5, "racy", GRAPH, {}]];
      }
      return fakeFetch(url, init);
    });
    expect(await promoteQueued("racy")).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/prompt"))).toBe(false);
  });
});
