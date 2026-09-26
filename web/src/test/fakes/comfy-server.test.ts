import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "./comfy-server";

let comfy: FakeComfy;

beforeEach(async () => {
  comfy = await startFakeComfy();
});

afterEach(async () => {
  await comfy.close();
});

async function queuePrompt(body: Record<string, unknown> = { prompt: { "1": { class_type: "KSampler", inputs: {} } }, client_id: "t" }) {
  return fetch(`${comfy.url}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("fake ComfyUI HTTP surface", () => {
  it("serves system stats in the shape the client parses", async () => {
    const res = await fetch(`${comfy.url}/system_stats`);
    await expect(res).toHaveStatusAndJson(200, { system: { os: "posix" } });
    const body = (await res.json()) as { devices: { vram_total: number }[] };
    expect(body.devices[0].vram_total).toBeGreaterThan(0);
  });

  it("lists a known model folder and 404s an unknown one (client maps 404 to [])", async () => {
    comfy.setFolder("checkpoints", ["sd_xl_base_1.0.safetensors"]);
    expect(await (await fetch(`${comfy.url}/models/checkpoints`)).json()).toEqual(["sd_xl_base_1.0.safetensors"]);
    expect((await fetch(`${comfy.url}/models/no_such_folder`)).status).toBe(404);
  });

  it("answers object_info for a known class, 404 for an unknown one", async () => {
    const res = await fetch(`${comfy.url}/object_info/KSampler`);
    const body = (await res.json()) as Record<string, { input: { required: { sampler_name: string[][] } } }>;
    expect(body.KSampler.input.required.sampler_name[0]).toContain("euler");
    expect((await fetch(`${comfy.url}/object_info/NoSuchNode`)).status).toBe(404);
    comfy.removeObjectInfo("KSampler");
    expect((await fetch(`${comfy.url}/object_info/KSampler`)).status).toBe(404);
  });

  it("queues a prompt and lands a success history entry with a counter-named output", async () => {
    const res = await queuePrompt();
    const { prompt_id } = (await res.json()) as { prompt_id: string };
    const history = (await (await fetch(`${comfy.url}/history/${prompt_id}`)).json()) as Record<
      string,
      { status: { status_str: string }; outputs: Record<string, { images: { filename: string }[] }> }
    >;
    expect(history[prompt_id].status.status_str).toBe("success");
    expect(history[prompt_id].outputs["9"].images[0].filename).toBe("ComfyUI_00001_.png");
    // A second render increments the counter, like the real output directory.
    const second = (await (await queuePrompt()).json()) as { prompt_id: string };
    const h2 = (await (await fetch(`${comfy.url}/history/${second.prompt_id}`)).json()) as typeof history;
    expect(h2[second.prompt_id].outputs["9"].images[0].filename).toBe("ComfyUI_00002_.png");
  });

  it("scripts the queue-succeeds-then-history-errors scenario", async () => {
    comfy.queueThenHistoryError("CUDA out of memory");
    const { prompt_id } = (await (await queuePrompt()).json()) as { prompt_id: string };
    const history = (await (await fetch(`${comfy.url}/history/${prompt_id}`)).json()) as Record<
      string,
      { status: { status_str: string; messages: [string, { exception_message: string }][] } }
    >;
    expect(history[prompt_id].status.status_str).toBe("error");
    expect(history[prompt_id].status.messages[0][1].exception_message).toBe("CUDA out of memory");
  });

  it("scripts node_errors on queue (one-shot), in the shape queuePrompt flattens", async () => {
    comfy.failNextPrompt({ message: "Prompt outputs failed validation", nodeErrors: { "3": { errors: [{ message: "Value not in list", details: "ckpt_name" }] } } });
    const res = await queuePrompt();
    await expect(res).toHaveStatusAndJson(400, {
      error: { message: "Prompt outputs failed validation" },
      node_errors: { "3": { errors: [{ message: "Value not in list", details: "ckpt_name" }] } },
    });
    expect((await queuePrompt()).status).toBe(200); // one-shot: next queue works
  });

  it("serves /view bytes and scripts a one-shot 404", async () => {
    const ok = await fetch(`${comfy.url}/view?filename=x.png&subfolder=safelight&type=output`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect((await ok.arrayBuffer()).byteLength).toBeGreaterThan(0);
    comfy.scriptView404();
    expect((await fetch(`${comfy.url}/view?filename=x.png`)).status).toBe(404);
    expect((await fetch(`${comfy.url}/view?filename=x.png`)).status).toBe(200);
  });

  it("accepts a multipart image upload and echoes name/subfolder/type", async () => {
    const form = new FormData();
    form.append("image", new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" }), "photo.png");
    form.append("subfolder", "studio");
    form.append("type", "input");
    const res = await fetch(`${comfy.url}/upload/image`, { method: "POST", body: form });
    await expect(res).toHaveStatusAndJson(200, { name: "photo.png", subfolder: "studio", type: "input" });
    expect(comfy.uploads).toEqual([{ filename: "photo.png", subfolder: "studio", bytes: 3 }]);
  });

  it("keeps a manual queue: pending → running → interrupt lands an error entry", async () => {
    comfy.setAutoComplete(false);
    const { prompt_id } = (await (await queuePrompt()).json()) as { prompt_id: string };
    let queue = (await (await fetch(`${comfy.url}/queue`)).json()) as { queue_pending: unknown[][]; queue_running: unknown[][] };
    expect(queue.queue_pending.map((e) => e[1])).toEqual([prompt_id]);
    comfy.markRunning(prompt_id);
    queue = (await (await fetch(`${comfy.url}/queue`)).json()) as typeof queue;
    expect(queue.queue_running.map((e) => e[1])).toEqual([prompt_id]);
    await fetch(`${comfy.url}/interrupt`, { method: "POST" });
    const history = (await (await fetch(`${comfy.url}/history/${prompt_id}`)).json()) as Record<string, { status: { status_str: string } }>;
    expect(history[prompt_id].status.status_str).toBe("error");
  });

  it("deletes pending jobs via POST /queue", async () => {
    comfy.setAutoComplete(false);
    const { prompt_id } = (await (await queuePrompt()).json()) as { prompt_id: string };
    await fetch(`${comfy.url}/queue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete: [prompt_id] }) });
    const queue = (await (await fetch(`${comfy.url}/queue`)).json()) as { queue_pending: unknown[][] };
    expect(queue.queue_pending).toEqual([]);
  });

  it("restart() keeps the port and resets the output counter", async () => {
    await queuePrompt();
    await comfy.restart();
    const { prompt_id } = (await (await queuePrompt()).json()) as { prompt_id: string };
    const history = (await (await fetch(`${comfy.url}/history/${prompt_id}`)).json()) as Record<string, { outputs: Record<string, { images: { filename: string }[] }> }>;
    // Counter reset: the "restarted" ComfyUI reuses ComfyUI_00001_.png — the stale-cache trap.
    expect(history[prompt_id].outputs["9"].images[0].filename).toBe("ComfyUI_00001_.png");
  });
});

describe("fake ComfyUI progress socket (RFC 6455)", () => {
  it("pushes scripted progress ticks then drops the socket", async () => {
    comfy.scriptProgressThenDrop(5, 25, "p-1");
    const ws = new WebSocket(`${comfy.wsUrl}?clientId=t`);
    const messages: { type: string; data: { value: number; max: number } }[] = [];
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));
    ws.addEventListener("message", (ev) => messages.push(JSON.parse(String(ev.data))));
    await closed;
    expect(messages).toHaveLength(5);
    expect(messages[0]).toEqual({ type: "progress", data: { value: 1, max: 25, prompt_id: "p-1" } });
    expect(messages[4].data.value).toBe(5);
  });

  it("supports manual pushes to a connected client", async () => {
    const ws = new WebSocket(`${comfy.wsUrl}?clientId=t`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    expect(comfy.wsClientCount()).toBe(1);
    const got = new Promise<string>((resolve) => ws.addEventListener("message", (ev) => resolve(String(ev.data))));
    comfy.sendProgress("p-9", 3, 20);
    expect(JSON.parse(await got)).toEqual({ type: "progress", data: { value: 3, max: 20, prompt_id: "p-9" } });
    ws.close();
  });
});
