import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { listThemes } from "@/lib/db/sessions";
import type { ThemeColors } from "@/lib/theme/contrast";
import { EXPORT_FORMATS, exportTheme, type ExportableTheme, type ExportFormat } from "@/lib/theme/exports";

function findTheme(name: string): ExportableTheme | undefined {
  const hit = listThemes().find((t) => t.name === name);
  if (!hit) return undefined;
  const data = hit.data as { description?: string; colors?: Partial<ThemeColors>; fonts?: { display?: string; body?: string; mono?: string } };
  const c = data.colors ?? {};
  if (!c.bg || !c.surface || !c.text || !c.muted || !c.accent || !c.accentText) return undefined;
  return {
    name,
    description: data.description,
    colors: c as ThemeColors,
    fonts: { display: data.fonts?.display ?? "", body: data.fonts?.body ?? "", mono: data.fonts?.mono || undefined },
  };
}

/** ?format=css|tailwind|tokens downloads the theme in that format. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const format = req.nextUrl.searchParams.get("format") as ExportFormat | null;
  if (!format || !EXPORT_FORMATS.includes(format)) {
    return Response.json({ error: `format must be one of: ${EXPORT_FORMATS.join(", ")}.` }, { status: 400 });
  }
  const theme = findTheme(name);
  if (!theme) return Response.json({ error: "Theme not found." }, { status: 404 });
  const { body, filename, contentType } = exportTheme(theme, format);
  return new Response(body, {
    headers: { "content-type": contentType, "content-disposition": `attachment; filename="${filename}"` },
  });
}

/** {action:"apply"} makes this the active theme; {action:"clear"} returns to the stock themes. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  let action: string;
  try {
    action = String(((await req.json()) as { action?: string }).action ?? "");
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const db = getDb();
  if (action === "apply") {
    const theme = findTheme(name);
    if (!theme) return Response.json({ error: "Theme not found." }, { status: 404 });
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('activeTheme', ?)").run(name);
    return Response.json({ active: name, theme });
  }
  if (action === "clear") {
    db.prepare("DELETE FROM settings WHERE key = 'activeTheme'").run();
    return Response.json({ active: null });
  }
  return Response.json({ error: 'action must be "apply" or "clear".' }, { status: 400 });
}
