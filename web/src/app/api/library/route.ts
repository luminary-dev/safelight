import type { NextRequest } from "next/server";
import { ensureIndex } from "@/lib/library";
import { searchLibrary, type SearchParams } from "@/lib/library/search";

/** Library search: q → FTS5 prefix match, everything else plain WHERE clauses. */
export async function GET(request: NextRequest) {
  await ensureIndex();
  const q = request.nextUrl.searchParams;
  const num = (key: string) => {
    const v = q.get(key);
    return v !== null && /^\d+$/.test(v) ? Number(v) : undefined;
  };
  const sort = q.get("sort");
  const params: SearchParams = {
    q: q.get("q") ?? undefined,
    model: q.get("model") ?? undefined,
    fav: q.get("fav") === "1" || q.get("fav") === "true",
    tag: q.get("tag") ?? undefined,
    from: q.get("from") ?? undefined,
    to: q.get("to") ?? undefined,
    sort: sort === "oldest" || sort === "largest" ? sort : "newest",
    offset: num("offset"),
    limit: num("limit"),
  };
  try {
    return Response.json(searchLibrary(params));
  } catch {
    return Response.json({ error: "Search failed." }, { status: 500 });
  }
}
