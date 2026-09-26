import type { NextRequest } from "next/server";
import { isLocalProvider, lookupTokenPrice } from "@/lib/usage/pricing";

/**
 * Pricing lookup for the composer's token/cost estimate. The client counts
 * tokens (chars/4 heuristic) and multiplies; this only exposes the per-Mtok
 * rates from the server-side pricing table. Local providers and unpriced
 * models answer null so the UI shows nothing.
 */
export async function GET(request: NextRequest) {
  const provider = request.nextUrl.searchParams.get("provider") ?? "";
  const model = request.nextUrl.searchParams.get("model") ?? "";
  if (!model) return Response.json({ error: "model is required." }, { status: 400 });
  if (isLocalProvider(provider)) return Response.json({ inPerMtok: null, outPerMtok: null, local: true });
  const price = lookupTokenPrice(model);
  return Response.json({ inPerMtok: price?.input ?? null, outPerMtok: price?.output ?? null, local: false });
}
