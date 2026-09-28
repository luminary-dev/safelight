import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { NextRequest } from "next/server";
import sharp from "sharp";
import { inputRef, isComfyUp, uploadImage } from "@/lib/comfy/client";
import { INPUT_DIR, safeJoin } from "@/lib/safelight-files";

const execFileAsync = promisify(execFile);

// Neither ComfyUI's image loader nor the cloud providers accept these — convert
// to JPEG at the boundary so an iPhone photo just works everywhere downstream.
const CONVERT_EXTS = new Set([".heic", ".heif", ".avif"]);

/**
 * macOS ships an HEVC decoder that sharp's prebuilt libvips is not allowed to
 * bundle (patent licensing), so an iPhone HEIC that sharp cannot decode goes
 * through the system's own converter. Fixed binary, temp-file arguments only.
 */
async function heicToJpegViaSips(bytes: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "sl-heic-"));
  try {
    const src = path.join(dir, "in.heic");
    const out = path.join(dir, "out.jpg");
    await writeFile(src, bytes);
    await execFileAsync("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "92", src, "--out", out]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function normalizeFile(f: File): Promise<File> {
  const ext = path.extname(f.name).toLowerCase();
  if (!CONVERT_EXTS.has(ext)) return f;
  const bytes = Buffer.from(await f.arrayBuffer());
  let jpeg: Buffer;
  try {
    // .rotate() bakes in the EXIF orientation — phone photos are usually stored sideways.
    jpeg = await sharp(bytes).rotate().jpeg({ quality: 92 }).toBuffer();
  } catch {
    try {
      if (process.platform !== "darwin") throw new Error("no system decoder");
      // Re-encode sips' output through sharp so the orientation is baked into pixels.
      jpeg = await sharp(await heicToJpegViaSips(bytes)).rotate().jpeg({ quality: 92 }).toBuffer();
    } catch {
      throw new Error(`${f.name} could not be converted to JPEG (this build cannot decode it) — export it as JPEG or PNG and attach that instead.`);
    }
  }
  return new File([new Uint8Array(jpeg)], `${path.basename(f.name, ext)}.jpg`, { type: "image/jpeg" });
}

/**
 * Mirrors an uploaded file into our own input folder. When ComfyUI was launched
 * externally (e.g. the desktop app attaching to a dev install), its input
 * directory is not ours — but cloud renders, chat attachments, and /api/view
 * read bytes from INPUT_DIR first. A failed mirror is only logged: ComfyUI has
 * the file and the readers fall back to its /view.
 */
async function mirrorToInputDir(subfolder: string, filename: string, bytes: Buffer): Promise<void> {
  const full = safeJoin(INPUT_DIR, subfolder, filename);
  if (!full) return;
  try {
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
  } catch (err) {
    console.warn(`[upload] could not mirror ${subfolder}/${filename} into the input folder:`, err instanceof Error ? err.message : err);
  }
}

/** Uploads through ComfyUI when it is up (so LoadImage sees the file), else writes straight into the shared input folder. */
export async function POST(request: NextRequest) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // A non-multipart body must be a 400, not an unhandled 500.
    return Response.json({ error: "Send the images as multipart form data." }, { status: 400 });
  }
  const rawFiles = form.getAll("files").filter((f): f is File => f instanceof File);
  if (rawFiles.length === 0) return Response.json({ error: "No files received." }, { status: 400 });
  let files: File[];
  try {
    files = await Promise.all(rawFiles.map(normalizeFile));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Conversion failed." }, { status: 400 });
  }
  try {
    if (await isComfyUp()) {
      const uploaded = await Promise.all(
        files.map(async (f) => {
          const u = await uploadImage(f);
          await mirrorToInputDir(u.subfolder ?? "", u.filename, Buffer.from(await f.arrayBuffer()));
          return u;
        }),
      );
      return Response.json({ files: uploaded.map((u) => ({ ...u, ref: inputRef(u) })) });
    }
    const dir = path.join(INPUT_DIR, "safelight");
    await mkdir(dir, { recursive: true });
    const saved = await Promise.all(
      files.map(async (f) => {
        const ext = path.extname(f.name) || ".png";
        const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
        await writeFile(path.join(dir, filename), Buffer.from(await f.arrayBuffer()));
        return { filename, subfolder: "safelight", type: "input", ref: `safelight/${filename}` };
      }),
    );
    return Response.json({ files: saved });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Upload failed." }, { status: 502 });
  }
}
