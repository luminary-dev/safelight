import { isComfyUp, systemStats, COMFY_URL } from "@/lib/comfy/client";

export async function GET() {
  const up = await isComfyUp();
  if (!up) return Response.json({ up: false, url: COMFY_URL }, { status: 200 });
  const stats = await systemStats().catch(() => null);
  return Response.json({ up: true, url: COMFY_URL, stats });
}
