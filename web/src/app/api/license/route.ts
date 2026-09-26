import type { NextRequest } from "next/server";
import { licenseStatus, removeLicense, saveLicense } from "@/lib/license";

export async function GET() {
  return Response.json(await licenseStatus());
}

/** Body: { license: string } — the raw contents of a safelight-license.json file. */
export async function POST(request: NextRequest) {
  let body: { license?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.license !== "string" || !body.license.trim()) {
    return Response.json({ error: "Paste the contents of your license file." }, { status: 400 });
  }
  const check = await saveLicense(body.license);
  if (!check.valid) {
    return Response.json({ error: check.reason }, { status: 400 });
  }
  return Response.json(await licenseStatus());
}

export async function DELETE() {
  await removeLicense();
  return Response.json(await licenseStatus());
}
