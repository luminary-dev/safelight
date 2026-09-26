import { searchCivitai } from "@/lib/models/civitai";
import { searchHuggingFace } from "@/lib/models/hf";
import { resolveModelPaths } from "@/lib/models/paths";
import { hydrateServiceEnv } from "@/lib/providers/keys";

export const runtime = "nodejs";

/** GET /api/models/search?q=...&source=hf|civitai — proxies the public model hubs. */
export async function GET(req: Request) {
  await hydrateServiceEnv();
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() ?? "";
  const source = searchParams.get("source") === "civitai" ? "civitai" : "hf";
  if (!q) return Response.json({ error: "Missing search query." }, { status: 400 });
  try {
    const results = source === "civitai" ? await searchCivitai(q) : await searchHuggingFace(q);
    return Response.json({ root: resolveModelPaths().root, source, results });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Search failed." }, { status: 502 });
  }
}
