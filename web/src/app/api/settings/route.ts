import type { NextRequest } from "next/server";
import { deleteSetting, getSetting, setSetting } from "@/lib/db/settings";
import { invalidateLocalOnlyCache } from "@/lib/privacy";

export const runtime = "nodejs";

/**
 * General app settings, allowlisted key by key. Structured stores with their own routes
 * and validation (mcp_servers, activeTheme) are deliberately not writable here.
 */
const KEYS: Record<string, "number" | "boolean" | "string"> = {
  spendLimitDaySoft: "number",
  spendLimitDayHard: "number",
  spendLimitMonthSoft: "number",
  spendLimitMonthHard: "number",
  telemetryEnabled: "boolean",
  localOnly: "boolean",
};

export async function GET() {
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(KEYS)) {
    const v = getSetting<unknown>(key, null);
    if (v !== null) values[key] = v;
  }
  return Response.json({ settings: values });
}

/** Partial update; null clears a key back to its default. */
export async function PATCH(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  for (const [key, value] of Object.entries(body)) {
    const kind = KEYS[key];
    if (!kind) return Response.json({ error: `Unknown setting: ${key}` }, { status: 400 });
    if (value === null) {
      deleteSetting(key);
      continue;
    }
    if (typeof value !== kind) return Response.json({ error: `${key} must be a ${kind}.` }, { status: 400 });
    if (kind === "number" && (!Number.isFinite(value as number) || (value as number) < 0)) return Response.json({ error: `${key} must be a non-negative number.` }, { status: 400 });
    setSetting(key, value);
  }
  invalidateLocalOnlyCache();
  return GET();
}
