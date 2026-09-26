import type { NextRequest } from "next/server";
import { invalidateCloudCatalog } from "@/lib/providers";
import { ALL_KEY_IDS, keyStatuses, setKey, validateKey, type KeyId } from "@/lib/providers/keys";

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
  if (!body.provider || !ALL_KEY_IDS.includes(body.provider as KeyId)) {
    return Response.json({ error: "Unknown provider." }, { status: 400 });
  }
  if (body.key !== null && (typeof body.key !== "string" || body.key.trim().length < 8)) {
    return Response.json({ error: "That key looks too short." }, { status: 400 });
  }
  const provider = body.provider as KeyId;
  await setKey(provider, body.key, body.baseUrl);
  invalidateCloudCatalog();
  // Tell the user whether the key actually works instead of failing silently at use time.
  const validation = body.key ? await validateKey(provider, body.key.trim(), body.baseUrl?.trim() || undefined) : undefined;
  return Response.json({ keys: await keyStatuses(), validation });
}
