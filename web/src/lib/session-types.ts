import type { JobOutput } from "@/lib/comfy/types";
import type { Job } from "@/lib/studio-state";

export type SessionKind = "chat" | "image" | "code";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  state: "running" | "done" | "error";
  note?: string;
  images?: JobOutput[];
}

export interface ChatAttachment {
  /** Reference usable by the image pipeline, e.g. "studio/photo.jpg". */
  ref: string;
  filename: string;
  subfolder: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  /** Tool activity from agent mode, rendered inline above the reply text. */
  tools?: ToolCall[];
  /** Images attached to a user message; sent to vision-capable models. */
  images?: ChatAttachment[];
}

/** A named grouping of chats and image sessions, e.g. one collection or shoot. */
export interface Project {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionBase {
  id: string;
  kind: SessionKind;
  title: string;
  /** True once the user renamed it; auto-titles stop updating. */
  titled: boolean;
  /** Project this session lives in; null/undefined means unfiled (visible under All projects only). */
  projectId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChatSession extends SessionBase {
  kind: "chat";
  model: string;
  messages: ChatMessage[];
  /** Agent mode: the model may call studio tools (generate and edit images, list models). */
  agent?: boolean;
}

export interface ImageSession extends SessionBase {
  kind: "image";
  /** Unsent prompt so switching sessions keeps each one's draft. */
  draft: string;
  currentJobId: string | null;
  jobs: Job[];
}

export interface CodeSession extends SessionBase {
  kind: "code";
  model: string;
  messages: ChatMessage[];
  /** Absolute folder on this machine the agent may read and edit. */
  root: string;
}

export type Session = ChatSession | ImageSession | CodeSession;

export function autoTitle(text: string, fallback: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return fallback;
  return t.length > 42 ? `${t.slice(0, 42).trimEnd()}…` : t;
}

export function newSession(kind: SessionKind): Session {
  const base = { id: crypto.randomUUID(), title: kind === "chat" ? "New chat" : kind === "code" ? "New coding session" : "New image session", titled: false, createdAt: Date.now(), updatedAt: Date.now() };
  if (kind === "chat") return { ...base, kind, model: "", messages: [] };
  if (kind === "code") return { ...base, kind, model: "", messages: [], root: "" };
  return { ...base, kind: "image", draft: "", currentJobId: null, jobs: [] };
}

export function newProject(title: string): Project {
  return { id: crypto.randomUUID(), title: title.trim() || "New project", createdAt: Date.now(), updatedAt: Date.now() };
}
