import { ensureIndex } from "@/lib/library";
import { duplicateGroups } from "@/lib/library/search";

/** Near-duplicate groups by perceptual hash (hamming ≤ 6), bucketed so it is not n². */
export async function GET() {
  await ensureIndex();
  try {
    return Response.json({ groups: duplicateGroups() });
  } catch {
    return Response.json({ error: "Duplicate scan failed." }, { status: 500 });
  }
}
