import { isComfyUp } from "@/lib/comfy/client";
import { emptyCatalog, getCatalog } from "@/lib/comfy/models";
import type { ModelCatalog, ModelEntry } from "@/lib/comfy/types";
import { cloudCatalog } from "@/lib/providers";

export async function GET() {
  const [up, cloud] = await Promise.all([isComfyUp(), cloudCatalog()]);
  let catalog: ModelCatalog = emptyCatalog();
  if (up) {
    try {
      catalog = await getCatalog();
    } catch {
      catalog = emptyCatalog();
    }
  }
  const cloudModels: ModelEntry[] = cloud.images.map((m) => ({
    name: m.id,
    folder: "cloud",
    family: "cloud",
    label: m.label,
    tags: m.tags,
    provider: m.provider,
    edit: m.edit,
  }));
  return Response.json({ ...catalog, models: [...catalog.models, ...cloudModels], cloudErrors: cloud.errors });
}
