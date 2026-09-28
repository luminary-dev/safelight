import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@/test/fakes/comfy-server";

/**
 * readImageBytesForRef: disk first, then ComfyUI /view. The fallback is the fix
 * for the desktop-app split-brain — an externally launched ComfyUI stores
 * uploads in ITS input directory, so the app's local read legitimately misses.
 */

let comfy: FakeComfy;
let dir: string;
let readImageBytesForRef: (ref: string) => Promise<{ bytes: Uint8Array; filename: string }>;
const prevEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-input-bytes-"));
  for (const key of ["COMFY_URL", "COMFY_OUTPUT_DIR", "COMFY_INPUT_DIR"]) prevEnv.set(key, process.env[key]);
  process.env.COMFY_OUTPUT_DIR = path.join(dir, "outputs");
  process.env.COMFY_INPUT_DIR = path.join(dir, "inputs");
  comfy = await startFakeComfy();
  process.env.COMFY_URL = comfy.url;
  ({ readImageBytesForRef } = await import("./input-bytes"));
});

afterAll(async () => {
  await comfy.close();
  for (const [key, value] of prevEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("readImageBytesForRef", () => {
  it("reads a local file without touching ComfyUI", async () => {
    await mkdir(path.join(dir, "inputs", "safelight"), { recursive: true });
    await writeFile(path.join(dir, "inputs", "safelight", "local.png"), Buffer.from("local-bytes"));
    const { bytes, filename } = await readImageBytesForRef("safelight/local.png");
    expect(filename).toBe("local.png");
    expect(Buffer.from(bytes).toString()).toBe("local-bytes");
  });

  it("falls back to ComfyUI /view when the file is not in our input folder", async () => {
    const { bytes, filename } = await readImageBytesForRef("safelight/only-on-comfy.png");
    expect(filename).toBe("only-on-comfy.png");
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("throws the original filesystem error when ComfyUI misses too", async () => {
    comfy.scriptView404();
    await expect(readImageBytesForRef("safelight/nowhere.png")).rejects.toThrow(/ENOENT/);
  });

  it("refuses a reference that escapes the input folder", async () => {
    await expect(readImageBytesForRef("../../etc/passwd")).rejects.toThrow(/Bad input reference/);
  });
});
