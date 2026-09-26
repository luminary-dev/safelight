import type { NextRequest } from "next/server";
import { extractAttachment, isExtractable, MAX_FILE_BYTES } from "@/lib/attachments";

/** Extracts text from one non-image attachment (PDF, text, CSV, code) so chat can carry it. */
export async function POST(request: NextRequest) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected multipart form data." }, { status: 400 });
  }
  const file = [...form.getAll("file"), ...form.getAll("files")].find((f): f is File => f instanceof File);
  if (!file) return Response.json({ error: "No file received." }, { status: 400 });
  if (!isExtractable(file.name)) return Response.json({ error: `Unsupported file type: ${file.name}` }, { status: 415 });
  if (file.size > MAX_FILE_BYTES) return Response.json({ error: `${file.name} is larger than 10 MB.` }, { status: 413 });
  try {
    const extracted = await extractAttachment(file.name, new Uint8Array(await file.arrayBuffer()));
    return Response.json(extracted);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not read the file." }, { status: 422 });
  }
}
