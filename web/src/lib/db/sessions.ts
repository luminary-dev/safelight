import "server-only";
import type { Project, Session } from "@/lib/session-types";
import { getDb } from "./index";

interface SessionRow {
  id: string;
  kind: string;
  project_id: string | null;
  title: string;
  titled: number;
  created_at: number;
  updated_at: number;
  data: string;
}

/** The row's JSON blob is the source of truth for mode-specific fields; the columns exist to query by. */
function toSession(row: SessionRow): Session {
  const parsed = JSON.parse(row.data) as Session;
  return { ...parsed, id: row.id, title: row.title, titled: row.titled === 1, projectId: row.project_id, createdAt: row.created_at, updatedAt: row.updated_at };
}

function writeSession(session: Session) {
  getDb()
    .prepare("INSERT OR REPLACE INTO sessions (id, kind, project_id, title, titled, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(session.id, session.kind, session.projectId ?? null, session.title, session.titled ? 1 : 0, session.createdAt, session.updatedAt, JSON.stringify(session));
}

export async function listSessions(): Promise<Session[]> {
  return (getDb().prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as SessionRow[]).map(toSession);
}

export async function getSession(id: string): Promise<Session | undefined> {
  const row = getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return row ? toSession(row) : undefined;
}

export async function upsertSession(session: Session): Promise<Session> {
  const next = { ...session, updatedAt: Date.now() };
  writeSession(next);
  return next;
}

export async function patchSession(id: string, patch: Partial<Session>): Promise<Session | undefined> {
  const current = await getSession(id);
  if (!current) return undefined;
  const next = { ...current, ...patch, id, kind: current.kind, updatedAt: Date.now() } as Session;
  writeSession(next);
  return next;
}

export async function deleteSession(id: string): Promise<boolean> {
  return getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
}

/**
 * Removes deleted output files from every image session's jobs, so bulk deletes in the
 * Library leave no dangling references. Refs are library-relative paths like
 * "safelight/qwen_00001_.png".
 */
export async function scrubOutputRefs(relPaths: string[]): Promise<number> {
  if (relPaths.length === 0) return 0;
  const doomed = new Set(relPaths);
  const matches = (o: { filename: string; subfolder?: string }) => doomed.has(o.subfolder ? `${o.subfolder}/${o.filename}` : o.filename);
  let touched = 0;
  for (const session of await listSessions()) {
    if (session.kind !== "image") continue;
    if (!session.jobs.some((j) => j.outputs.some(matches))) continue;
    const next = { ...session, jobs: session.jobs.map((j) => ({ ...j, outputs: j.outputs.filter((o) => !matches(o)) })), updatedAt: Date.now() };
    writeSession(next);
    touched++;
  }
  return touched;
}

export async function listProjects(): Promise<Project[]> {
  return getDb().prepare("SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY updated_at DESC").all() as Project[];
}

export async function upsertProject(project: Project): Promise<Project> {
  const next = { ...project, updatedAt: Date.now() };
  getDb().prepare("INSERT OR REPLACE INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(next.id, next.title, next.createdAt, next.updatedAt);
  return next;
}

export async function patchProject(id: string, patch: Partial<Project>): Promise<Project | undefined> {
  const row = getDb().prepare("SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?").get(id) as Project | undefined;
  if (!row) return undefined;
  const next = { ...row, ...patch, id, updatedAt: Date.now() };
  getDb().prepare("UPDATE projects SET title = ?, updated_at = ? WHERE id = ?").run(next.title, next.updatedAt, id);
  return next;
}

/** Removes the project; its sessions are kept and become unfiled. */
export async function deleteProject(id: string): Promise<boolean> {
  const db = getDb();
  const run = db.transaction(() => {
    // Sessions carry projectId inside their JSON too; rewrite it so the blob and column agree.
    const rows = db.prepare("SELECT * FROM sessions WHERE project_id = ?").all(id) as SessionRow[];
    for (const row of rows) {
      const session = toSession(row);
      writeSession({ ...session, projectId: null });
    }
    return db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  });
  return run();
}

export function saveTheme(name: string, data: unknown): void {
  getDb().prepare("INSERT OR REPLACE INTO themes (name, data, saved_at) VALUES (?, ?, ?)").run(name, JSON.stringify(data), Date.now());
}

export function listThemes(): { name: string; data: unknown; savedAt: number }[] {
  return (getDb().prepare("SELECT name, data, saved_at AS savedAt FROM themes ORDER BY saved_at DESC").all() as { name: string; data: string; savedAt: number }[]).map((t) => ({
    ...t,
    data: JSON.parse(t.data),
  }));
}
