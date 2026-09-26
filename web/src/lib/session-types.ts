import type { JobOutput } from "@/lib/comfy/types";
import type { Job } from "@/lib/safelight-state";

export type SessionKind = "chat" | "image" | "code" | "design";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  state: "running" | "done" | "error";
  /** The tool's structured result, for cards that render richer previews (e.g. theme swatches). */
  result?: unknown;
  note?: string;
  images?: JobOutput[];
}

export interface ChatAttachment {
  /** Reference usable by the image pipeline, e.g. "safelight/photo.jpg". */
  ref: string;
  filename: string;
  subfolder: string;
}

/** A non-image file attached to a message, already extracted to text server-side. */
export interface ChatFile {
  name: string;
  text: string;
  /** True when the extracted text was clipped to the server limit. */
  truncated?: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  /** Tool activity from agent mode, rendered inline above the reply text. */
  tools?: ToolCall[];
  /** Images attached to a user message; sent to vision-capable models. */
  images?: ChatAttachment[];
  /** Non-image attachments (PDF, text, CSV, code) rendered as collapsed chips. */
  files?: ChatFile[];
}

/** Per-session sampling parameters; unset fields use the provider defaults. */
export interface ChatParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
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
  /** Agent mode: the model may call Safelight tools (generate and edit images, list models). */
  agent?: boolean;
  /** Per-session system prompt, appended to the default — never replaces it. */
  system?: string;
  /** Per-session sampling parameters. */
  params?: ChatParams;
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
  /** Extra absolute paths the user approved beyond the root (a folder approves its subtree). */
  approvedPaths?: string[];
}

export interface DesignSession extends SessionBase {
  kind: "design";
  model: string;
  messages: ChatMessage[];
}

export type Session = ChatSession | ImageSession | CodeSession | DesignSession;

export function autoTitle(text: string, fallback: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return fallback;
  return t.length > 42 ? `${t.slice(0, 42).trimEnd()}…` : t;
}

export function newSession(kind: SessionKind): Session {
  const base = { id: crypto.randomUUID(), title: kind === "chat" ? "New chat" : kind === "code" ? "New coding session" : kind === "design" ? "New design session" : "New image session", titled: false, createdAt: Date.now(), updatedAt: Date.now() };
  if (kind === "chat") return { ...base, kind, model: "", messages: [] };
  if (kind === "code") return { ...base, kind, model: "", messages: [], root: "", approvedPaths: [] };
  if (kind === "design") return { ...base, kind, model: "", messages: [] };
  return { ...base, kind: "image", draft: "", currentJobId: null, jobs: [] };
}

export function newProject(title: string): Project {
  return { id: crypto.randomUUID(), title: title.trim() || "New project", createdAt: Date.now(), updatedAt: Date.now() };
}
