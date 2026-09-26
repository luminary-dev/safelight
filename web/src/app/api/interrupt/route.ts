import { interrupt } from "@/lib/comfy/client";

export async function POST() {
  try {
    await interrupt();
  } catch (err) {
    // ComfyUI unreachable must be a clean upstream error, not an unhandled 500.
    return Response.json({ error: err instanceof Error ? err.message : "Failed to interrupt." }, { status: 502 });
  }
  return Response.json({ ok: true });
}
