import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Project, Session } from "@/lib/session-types";

const FILE = process.env.SAFELIGHT_SESSIONS_FILE ?? process.env.STUDIO_SESSIONS_FILE ?? path.resolve(process.cwd(), "..", "data", "sessions.json");

interface Store {
  sessions: Session[];
  projects: Project[];
}

let queue: Promise<void> = Promise.resolve();

async function read(): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf8")) as Partial<Store>;
    return { sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [], projects: Array.isArray(parsed.projects) ? parsed.projects : [] };
  } catch {
    return { sessions: [], projects: [] };
  }
}

async function write(store: Store): Promise<void> {
  await mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2));
  await rename(tmp, FILE);
}

/** Serialises read-modify-write so concurrent PATCHes never clobber each other. */
function mutate<T>(fn: (store: Store) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const store = await read();
    const result = await fn(store);
    await write(store);
    return result;
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function listSessions(): Promise<Session[]> {
  const { sessions } = await read();
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getSession(id: string): Promise<Session | undefined> {
  return (await read()).sessions.find((s) => s.id === id);
}

export async function upsertSession(session: Session): Promise<Session> {
  return mutate((store) => {
    const i = store.sessions.findIndex((s) => s.id === session.id);
    const next = { ...session, updatedAt: Date.now() };
    if (i === -1) store.sessions.push(next);
    else store.sessions[i] = next;
    return next;
  });
}

export async function patchSession(id: string, patch: Partial<Session>): Promise<Session | undefined> {
  return mutate((store) => {
    const i = store.sessions.findIndex((s) => s.id === id);
    if (i === -1) return undefined;
    const next = { ...store.sessions[i], ...patch, id, kind: store.sessions[i].kind, updatedAt: Date.now() } as Session;
    store.sessions[i] = next;
    return next;
  });
}

export async function deleteSession(id: string): Promise<boolean> {
  return mutate((store) => {
    const before = store.sessions.length;
    store.sessions = store.sessions.filter((s) => s.id !== id);
    return store.sessions.length !== before;
  });
}

export async function listProjects(): Promise<Project[]> {
  const { projects } = await read();
  return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function upsertProject(project: Project): Promise<Project> {
  return mutate((store) => {
    const i = store.projects.findIndex((p) => p.id === project.id);
    const next = { ...project, updatedAt: Date.now() };
    if (i === -1) store.projects.push(next);
    else store.projects[i] = next;
    return next;
  });
}

export async function patchProject(id: string, patch: Partial<Project>): Promise<Project | undefined> {
  return mutate((store) => {
    const i = store.projects.findIndex((p) => p.id === id);
    if (i === -1) return undefined;
    const next = { ...store.projects[i], ...patch, id, updatedAt: Date.now() };
    store.projects[i] = next;
    return next;
  });
}

/** Removes the project; its sessions are kept and become unfiled. */
export async function deleteProject(id: string): Promise<boolean> {
  return mutate((store) => {
    const before = store.projects.length;
    store.projects = store.projects.filter((p) => p.id !== id);
    store.sessions = store.sessions.map((s) => (s.projectId === id ? { ...s, projectId: undefined } : s));
    return store.projects.length !== before;
  });
}
