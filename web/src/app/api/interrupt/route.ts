import { interrupt } from "@/lib/comfy/client";

export async function POST() {
  await interrupt();
  return Response.json({ ok: true });
}
