import type { NextRequest } from "next/server";
import type { Project, Session } from "@/lib/session-types";
import { getDb } from "@/lib/db";
import { saveTheme, upsertProject, upsertSession } from "@/lib/db/sessions";

interface ExportShape {
  format?: string;
  version?: number;
  sessions?: Session[];
  projects?: Project[];
  themes?: { name: string; data: unknown; savedAt?: number }[];
  settings?: { key: string; value: unknown }[];
}

/** Restores a /api/export document. Upserts by id, so importing into an existing install merges. */
export async function POST(request: NextRequest) {
  let body: ExportShape;
  try {
    body = (await request.json()) as ExportShape;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.format !== "safelight-export" || body.version !== 1) return Response.json({ error: "Not a Safelight export file." }, { status: 400 });

  let projects = 0;
  let sessions = 0;
  for (const p of body.projects ?? []) {
    if (p?.id && typeof p.title === "string") {
      await upsertProject(p);
      projects++;
    }
  }
  for (const s of body.sessions ?? []) {
    if (s?.id && (s.kind === "chat" || s.kind === "image" || s.kind === "code" || s.kind === "design")) {
      await upsertSession(s);
      sessions++;
    }
  }
  for (const t of body.themes ?? []) {
    if (t?.name) saveTheme(t.name, t.data);
  }
  const setSetting = getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  for (const s of body.settings ?? []) {
    if (s?.key) setSetting.run(s.key, JSON.stringify(s.value));
  }
  return Response.json({ ok: true, projects, sessions, themes: (body.themes ?? []).length });
}
