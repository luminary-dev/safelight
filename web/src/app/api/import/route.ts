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

/** Timestamps in a hostile document may be missing or garbage; the NOT NULL columns need real numbers. */
function toTime(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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

  const now = Date.now();
  let projects = 0;
  let sessions = 0;
  let themes = 0;
  for (const p of body.projects ?? []) {
    if (p && typeof p.id === "string" && p.id && typeof p.title === "string") {
      await upsertProject({ ...p, createdAt: toTime(p.createdAt, now), updatedAt: toTime(p.updatedAt, now) });
      projects++;
    }
  }
  for (const s of body.sessions ?? []) {
    if (s && typeof s.id === "string" && s.id && typeof s.title === "string" && (s.kind === "chat" || s.kind === "image" || s.kind === "code" || s.kind === "design")) {
      await upsertSession({ ...s, titled: Boolean(s.titled), createdAt: toTime(s.createdAt, now), updatedAt: toTime(s.updatedAt, now) });
      sessions++;
    }
  }
  for (const t of body.themes ?? []) {
    if (t && typeof t.name === "string" && t.name) {
      saveTheme(t.name, t.data);
      themes++;
    }
  }
  const setSetting = getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  for (const s of body.settings ?? []) {
    if (s && typeof s.key === "string" && s.key) setSetting.run(s.key, JSON.stringify(s.value));
  }
  return Response.json({ ok: true, projects, sessions, themes });
}
