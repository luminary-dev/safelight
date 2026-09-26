import { getDb } from "@/lib/db";
import { listProjects, listSessions, listThemes } from "@/lib/db/sessions";

/** The data-portability guarantee: everything the user made, as one JSON document. Never keys. */
export async function GET() {
  const settings = (getDb().prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[]).map((r) => ({ key: r.key, value: JSON.parse(r.value) as unknown }));
  const body = {
    format: "safelight-export",
    version: 1,
    exportedAt: Date.now(),
    sessions: await listSessions(),
    projects: await listProjects(),
    themes: listThemes(),
    settings,
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="safelight-export-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
