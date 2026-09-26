import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";
import { inputRef, isComfyUp, uploadImage } from "@/lib/comfy/client";
import { INPUT_DIR } from "@/lib/safelight-files";

/** Uploads through ComfyUI when it is up (so LoadImage sees the file), else writes straight into the shared input folder. */
export async function POST(request: NextRequest) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // A non-multipart body must be a 400, not an unhandled 500.
    return Response.json({ error: "Send the images as multipart form data." }, { status: 400 });
  }
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) return Response.json({ error: "No files received." }, { status: 400 });
  try {
    if (await isComfyUp()) {
      const uploaded = await Promise.all(files.map((f) => uploadImage(f)));
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
