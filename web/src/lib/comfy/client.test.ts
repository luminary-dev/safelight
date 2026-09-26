import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TINY_PNG } from "@/test/fakes/http";
import { startFakeComfy, type FakeComfy } from "@/test/fakes/comfy-server";

/**
 * lib/comfy/client.ts against the fake ComfyUI (TEST-BRIEF §6): queuePrompt's
 * node_errors flattening, listFolder's 404 → [], uploadImage, fetchView, and
 * inputRef. Queue manipulation (cancel/promote/clear) lives in
 * client.queue.test.ts.
 */

let comfy: FakeComfy;
let client: typeof import("./client");

beforeAll(async () => {
  comfy = await startFakeComfy();
  // COMFY_URL is read at module load, so import a fresh client pointed at the fake.
  vi.resetModules();
  vi.stubEnv("COMFY_URL", comfy.url);
  client = await import("./client");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await comfy.close();
});

describe("queuePrompt", () => {
  it("returns the prompt id on success", async () => {
    const res = await client.queuePrompt({ "1": { class_type: "KSampler", inputs: {} } }, "client-1");
    expect(res.prompt_id).toMatch(/^fake-prompt-/);
    expect(res.node_errors).toEqual({});
  });

  it("flattens node_errors into one readable message, details included", async () => {
    comfy.failNextPrompt({
      message: "Prompt outputs failed validation",
      nodeErrors: {
        "4": { errors: [{ message: "Value not in list", details: "ckpt_name: 'missing.safetensors'" }] },
        "7": { errors: [{ message: "Required input is missing" }] },
      },
    });
    await expect(client.queuePrompt({}, "client-1")).rejects.toThrow(
      "Prompt outputs failed validation | Value not in list: ckpt_name: 'missing.safetensors' | Required input is missing",
    );
  });

  it("keeps the status on the flattened error", async () => {
    comfy.failNextPrompt({ message: "bad graph" });
    const err = await client.queuePrompt({}, "c").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(client.ComfyError);
    expect((err as InstanceType<typeof client.ComfyError>).status).toBe(400);
  });
});

describe("listFolder", () => {
  it("lists a known folder's files", async () => {
    comfy.setFolder("checkpoints", ["sd_xl_base_1.0.safetensors"]);
    expect(await client.listFolder("checkpoints")).toEqual(["sd_xl_base_1.0.safetensors"]);
  });

  it("returns [] for a folder ComfyUI does not know (404), instead of throwing", async () => {
    expect(await client.listFolder("no_such_folder")).toEqual([]);
  });

  it("still throws when ComfyUI itself is unreachable", async () => {
    const dead = await startFakeComfy();
    await dead.close();
    vi.resetModules();
    vi.stubEnv("COMFY_URL", dead.url);
    const offline = await import("./client");
    await expect(offline.listFolder("checkpoints")).rejects.toThrow();
    vi.stubEnv("COMFY_URL", comfy.url);
    vi.resetModules();
  });
});

describe("uploadImage", () => {
  it("posts the file as multipart and maps the reply to a JobOutput", async () => {
    const file = new File([TINY_PNG], "brush-mask.png", { type: "image/png" });
    const out = await client.uploadImage(file, "safelight");
    expect(out).toEqual({ filename: "brush-mask.png", subfolder: "safelight", type: "input" });
    expect(comfy.uploads).toEqual([{ filename: "brush-mask.png", subfolder: "safelight", bytes: TINY_PNG.length }]);
  });

  it("defaults the subfolder to safelight", async () => {
    const file = new File([TINY_PNG], "ref.png", { type: "image/png" });
    const out = await client.uploadImage(file);
    expect(out.subfolder).toBe("safelight");
  });
});

describe("fetchView", () => {
  it("streams the file bytes for an output reference", async () => {
    const res = await client.fetchView({ filename: "a.png", subfolder: "safelight", type: "output" });
    expect(res.ok).toBe(true);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(TINY_PNG);
  });

  it("passes a 404 through for a missing file", async () => {
    comfy.scriptView404();
    const res = await client.fetchView({ filename: "gone.png", subfolder: "", type: "output" });
    expect(res.status).toBe(404);
  });
});

describe("inputRef", () => {
  it("prefixes the subfolder when present", () => {
    expect(client.inputRef({ filename: "a.png", subfolder: "safelight", type: "input" })).toBe("safelight/a.png");
    expect(client.inputRef({ filename: "a.png", subfolder: "", type: "input" })).toBe("a.png");
  });
});

describe("isComfyUp", () => {
  it("is true against the fake and false against a closed port", async () => {
    expect(await client.isComfyUp()).toBe(true);
    const dead = await startFakeComfy();
    await dead.close();
    vi.resetModules();
    vi.stubEnv("COMFY_URL", dead.url);
    const offline = await import("./client");
    expect(await offline.isComfyUp()).toBe(false);
    vi.stubEnv("COMFY_URL", comfy.url);
    vi.resetModules();
  });
});
