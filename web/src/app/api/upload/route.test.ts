import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { startFakeComfy, type FakeComfy } from "@/test/fakes/comfy-server";

/**
 * /api/upload (TEST-BRIEF §8): 1 and N files, none → 400, the ComfyUI-up path
 * vs the inputs/safelight fallback, a non-image content type, and hostile file
 * names. COMFY_URL and INPUT_DIR are captured at import time, so both are wired
 * before the route module loads.
 */

let comfy: FakeComfy;
let dir: string;
let POST: (req: NextRequest) => Promise<Response>;
const prevEnv = new Map<string, string | undefined>();

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-upload-api-"));
  for (const key of ["SAFELIGHT_DATA_DIR", "COMFY_URL", "COMFY_OUTPUT_DIR", "COMFY_INPUT_DIR"]) prevEnv.set(key, process.env[key]);
  process.env.SAFELIGHT_DATA_DIR = path.join(dir, "data");
  process.env.COMFY_OUTPUT_DIR = path.join(dir, "outputs");
  process.env.COMFY_INPUT_DIR = path.join(dir, "inputs");
  comfy = await startFakeComfy();
  process.env.COMFY_URL = comfy.url;
  ({ POST } = await import("./route"));
});

afterAll(async () => {
  await comfy.close();
  for (const [key, value] of prevEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

function upload(files: { name: string; type?: string; bytes?: Buffer }[]): Promise<Response> {
  const form = new FormData();
  for (const f of files) form.append("files", new File([new Uint8Array(f.bytes ?? PNG)], f.name, { type: f.type ?? "image/png" }));
  return POST(new Request("http://localhost:3001/api/upload", { method: "POST", body: form }) as unknown as NextRequest);
}

interface UploadBody {
  files: { filename: string; subfolder: string; ref: string }[];
}

describe("with ComfyUI up", () => {
  it("uploads one file through ComfyUI and returns its input ref", async () => {
    const res = await upload([{ name: "photo.png" }]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadBody;
    expect(body.files).toHaveLength(1);
    expect(body.files[0].ref).toContain("photo.png");
    expect(comfy.uploads.map((u) => u.filename)).toContain("photo.png");
  });

  it("uploads N files in one request", async () => {
    const res = await upload([{ name: "a.png" }, { name: "b.png" }, { name: "c.jpg", type: "image/jpeg" }]);
    const body = (await res.json()) as UploadBody;
    expect(body.files.map((f) => f.filename)).toEqual(["a.png", "b.png", "c.jpg"]);
  });

  it("rejects a request with no files as 400", async () => {
    const res = await upload([]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/No files/);
  });

  it("a malformed (non-form) body is a 400, not an unhandled 500", async () => {
    const res = await POST(new Request("http://localhost:3001/api/upload", { method: "POST", body: "{json}" }) as unknown as NextRequest);
    expect(res.status).toBe(400);
  });

  it("mirrors the ComfyUI upload into our own input folder (an external ComfyUI keeps a different one)", async () => {
    const res = await upload([{ name: "mirror-me.png" }]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadBody;
    const f = body.files[0];
    // ComfyUI received it AND the same bytes exist under INPUT_DIR for cloud renders/chat.
    expect(comfy.uploads.map((u) => u.filename)).toContain("mirror-me.png");
    expect(existsSync(path.join(dir, "inputs", f.subfolder, f.filename))).toBe(true);
  });

  it("converts an iPhone-style HEIF family file to JPEG before anything downstream sees it", async () => {
    // sharp cannot ENCODE .heic in this build, but .avif is the same HEIF container
    // family and exercises the identical convert path.
    const avif = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 30, b: 30 } } })
      .avif()
      .toBuffer();
    const res = await upload([{ name: "IMG_8058.avif", type: "image/avif", bytes: avif }]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadBody;
    expect(body.files[0].filename).toBe("IMG_8058.jpg");
    // What ComfyUI got is a real JPEG, not the original container.
    expect(comfy.uploads.map((u) => u.filename)).toContain("IMG_8058.jpg");
    const mirrored = await readFile(path.join(dir, "inputs", body.files[0].subfolder, body.files[0].filename));
    expect(mirrored.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG SOI
  });

  it("an undecodable .heic is a 400 that says what to do, and reaches neither disk nor ComfyUI", async () => {
    const before = comfy.uploads.length;
    const res = await upload([{ name: "broken.heic", type: "image/heic", bytes: Buffer.from("not an image") }]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/broken\.heic.*JPEG or PNG/);
    expect(comfy.uploads.length).toBe(before);
    expect(existsSync(path.join(dir, "inputs", "safelight", "broken.heic"))).toBe(false);
  });

  // sharp's prebuilt libvips has no HEVC decoder (patents), so a real iPhone
  // HEIC exercises the macOS sips fallback. The fixture is made by sips itself.
  it.runIf(process.platform === "darwin")("converts a real HEVC HEIC through the system decoder", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "sl-heic-fixture-"));
    let heic: Buffer;
    try {
      const src = path.join(tmp, "px.png");
      await writeFile(src, await sharp({ create: { width: 8, height: 6, channels: 3, background: { r: 10, g: 200, b: 50 } } }).png().toBuffer());
      await promisify(execFile)("/usr/bin/sips", ["-s", "format", "heic", src, "--out", path.join(tmp, "px.heic")]);
      heic = await readFile(path.join(tmp, "px.heic"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    const res = await upload([{ name: "IMG_0001.heic", type: "image/heic", bytes: heic }]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadBody;
    expect(body.files[0].filename).toBe("IMG_0001.jpg");
    const mirrored = await readFile(path.join(dir, "inputs", body.files[0].subfolder, body.files[0].filename));
    expect(mirrored.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });
});

describe("with ComfyUI down (local fallback)", () => {
  beforeAll(async () => {
    await comfy.close();
  });

  it("writes into inputs/safelight with a generated safe name, whatever the client called the file", async () => {
    const res = await upload([{ name: "../../evil\u0000name.png" }]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadBody;
    expect(body.files).toHaveLength(1);
    expect(body.files[0].subfolder).toBe("safelight");
    // The saved name is generated server-side: no separators, no null bytes, inside the sandbox.
    expect(body.files[0].filename).not.toMatch(/[/\\\u0000]/);
    const saved = readdirSync(path.join(dir, "inputs", "safelight"));
    expect(saved).toContain(body.files[0].filename);
    expect(existsSync(path.join(dir, "evilname.png"))).toBe(false);
  });

  it("handles several files and non-image types without escaping the input dir", async () => {
    const res = await upload([
      { name: "one.png" },
      { name: "script.sh", type: "text/x-sh", bytes: Buffer.from("#!/bin/sh\n") },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadBody;
    expect(body.files).toHaveLength(2);
    for (const f of body.files) {
      expect(existsSync(path.join(dir, "inputs", "safelight", f.filename))).toBe(true);
    }
  });
});
