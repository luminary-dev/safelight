import type { NextRequest } from "next/server";
import { usageSummary } from "@/lib/usage/record";

/** Cost ledger aggregation: spend by day, provider, and mode, plus totals. */
export async function GET(request: NextRequest) {
  const raw = Number(request.nextUrl.searchParams.get("days") ?? 30);
  const days = Number.isFinite(raw) ? raw : 30;
  return Response.json(usageSummary(days));
}
