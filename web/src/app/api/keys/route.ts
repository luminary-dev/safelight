import type { NextRequest } from "next/server";
import { invalidateCloudCatalog } from "@/lib/providers";
import { keyStatuses, PROVIDERS, setKey, validateKey, type ProviderId } from "@/lib/providers/keys";

export async function GET() {
  return Response.json({ keys: await keyStatuses() });
}

/** Body: { provider, key } to set, or { provider, key: null } to remove. The key is never echoed back. */
export async function POST(request: NextRequest) {
  let body: { provider?: string; key?: string | null; baseUrl?: string | null };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.provider || !PROVIDERS.includes(body.provider as ProviderId)) {
    return Response.json({ error: "Unknown provider." }, { status: 400 });
  }
  if (body.key !== null && (typeof body.key !== "string" || body.key.trim().length < 8)) {
    return Response.json({ error: "That key looks too short." }, { status: 400 });
  }
  const provider = body.provider as ProviderId;
  await setKey(provider, body.key, body.baseUrl);
  invalidateCloudCatalog();
  // Tell the user whether the key actually works instead of failing silently at use time.
  const validation = body.key ? await validateKey(provider, body.key.trim(), body.baseUrl?.trim() || undefined) : undefined;
  return Response.json({ keys: await keyStatuses(), validation });
}
