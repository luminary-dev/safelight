import type { NextRequest } from "next/server";
import type { GenerateRequest } from "@/lib/comfy/types";
import { queueLocal, runCloud, sanitizeRequest } from "@/lib/generate-core";

export async function POST(request: NextRequest) {
  let body: Partial<GenerateRequest> & { clientId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const clientId = typeof body.clientId === "string" && body.clientId ? body.clientId : "studio";

  let req: GenerateRequest;
  try {
    req = sanitizeRequest(body);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Bad request." }, { status: 400 });
  }

  if (req.model.folder === "cloud") {
    try {
      const outputs = await runCloud(req);
      return Response.json({ id: `cloud-${crypto.randomUUID()}`, seed: req.seed, outputs, state: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Cloud generation failed.";
      return Response.json({ error: message }, { status: /empty|no provider|no .* key|bad input/i.test(message) ? 400 : 502 });
    }
  }

  try {
    const { id, graph, freed } = await queueLocal(req, clientId);
    return Response.json({ id, seed: req.seed, graph, state: "queued", freedChatModels: freed });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to queue generation.";
    const status = /empty|needs|pick|unsupported/i.test(message) ? 400 : 502;
    return Response.json({ error: message }, { status });
  }
}
