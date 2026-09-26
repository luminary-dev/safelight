import { getDb } from "@/lib/db";
import { listThemes } from "@/lib/db/sessions";

/** Saved themes plus which one is applied, so the client can boot into it. */
export async function GET() {
  const themes = listThemes();
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'activeTheme'").get() as { value: string } | undefined;
  // A stale pointer (theme deleted or renamed) reads as no active theme.
  const active = row && themes.some((t) => t.name === row.value) ? row.value : null;
  return Response.json({ themes, active });
}
