import "server-only";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDef } from "./tools";

const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_ENTRIES = 400;
const MAX_DEPTH = 6;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".venv", "venv", "__pycache__", "dist", "build", ".DS_Store"]);

export function codeSystemPrompt(root: string): string {
  return (
    `You are Safelight's coding assistant, working in the folder ${root} on the user's machine. ` +
    "You have tools: list_files to explore, read_file to look at code, edit_file for exact string replacements, and write_file to create or overwrite a file. " +
    "Paths outside the workspace are allowed only after the user approves each one, so prefer staying inside it. Always read a file before editing it, and make the smallest change that does the job. old_string must match the file exactly, including indentation. " +
    "After changing files, summarise briefly what you changed and where. If a request needs running commands or leaving the folder, say you cannot do that."
  );
}

export function codeToolDefs(): ToolDef[] {
  return [
    {
      name: "list_files",
      description: "List files and folders in the workspace, recursively. Optionally filter by a substring of the path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Folder to list, relative to the workspace root. Defaults to the root." },
          pattern: { type: "string", description: "Only return paths containing this substring (case-insensitive)." },
        },
      },
    },
    {
      name: "read_file",
      description: "Read a text file from the workspace. Returns numbered lines.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace root." },
          offset: { type: "number", description: "1-based line to start from. Defaults to 1." },
          limit: { type: "number", description: "How many lines to return. Defaults to 400." },
        },
        required: ["path"],
      },
    },
    {
      name: "edit_file",
      description: "Replace an exact string in a file. old_string must match exactly and, unless replace_all is true, appear exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace root." },
          old_string: { type: "string", description: "The exact text to replace." },
          new_string: { type: "string", description: "The replacement text." },
          replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    {
      name: "write_file",
      description: "Create or overwrite a file with the given content. Parent folders are created as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace root." },
          content: { type: "string", description: "The full file content." },
        },
        required: ["path", "content"],
      },
    },
  ];
}

export interface CodeAccess {
  root: string;
  /** Absolute paths (files, or folder subtrees) the user has already allowed beyond the root. */
  approved: string[];
  /** Pauses the run and asks the user; resolves true only on an explicit Allow. */
  requestApproval: (absPath: string, tool: string) => Promise<boolean>;
}

function within(abs: string, base: string): boolean {
  return abs === base || abs.startsWith(base + path.sep);
}

/** Resolves a path against the root; anything beyond root or the approved list pauses to ask the user. Exported for tests. */
export async function resolvePath(access: CodeAccess, rel: unknown, tool: string): Promise<string> {
  const normRoot = path.resolve(access.root);
  const abs = path.resolve(normRoot, typeof rel === "string" && rel ? rel : ".");
  if (within(abs, normRoot)) return abs;
  if (access.approved.some((a) => within(abs, a))) return abs;
  const ok = await access.requestApproval(abs, tool);
  if (!ok) throw new Error(`The user declined access to ${abs}.`);
  access.approved.push(abs);
  return abs;
}

async function walk(dir: string, root: string, out: string[], depth: number): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (out.length >= MAX_ENTRIES) return;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full);
    if (e.isDirectory()) {
      out.push(rel + "/");
      await walk(full, root, out, depth + 1);
    } else {
      out.push(rel);
    }
  }
}

export async function executeCodeTool(name: string, args: Record<string, unknown>, access: CodeAccess): Promise<{ result: unknown; note?: string }> {
  switch (name) {
    case "list_files": {
      const dir = await resolvePath(access, args.path, name);
      const all: string[] = [];
      await walk(dir, dir, all, 0);
      const pattern = typeof args.pattern === "string" ? args.pattern.toLowerCase() : "";
      const files = pattern ? all.filter((f) => f.toLowerCase().includes(pattern)) : all;
      return { result: { files, truncated: all.length >= MAX_ENTRIES }, note: `${files.length} entr${files.length === 1 ? "y" : "ies"}` };
    }
    case "read_file": {
      const file = await resolvePath(access, args.path, name);
      const info = await stat(file);
      if (!info.isFile()) throw new Error("Not a file.");
      if (info.size > MAX_READ_BYTES) throw new Error(`File is ${Math.round(info.size / 1024)} KB; only files up to ${MAX_READ_BYTES / 1024} KB can be read.`);
      const raw = await readFile(file);
      if (raw.includes(0)) throw new Error("This looks like a binary file.");
      const lines = raw.toString("utf8").split("\n");
      const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
      const limit = Math.max(1, Math.min(2000, Math.floor(Number(args.limit) || 400)));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join("\n");
      return { result: { path: String(args.path), totalLines: lines.length, content: numbered }, note: `${slice.length} lines` };
    }
    case "edit_file": {
      const file = await resolvePath(access, args.path, name);
      const oldStr = String(args.old_string ?? "");
      const newStr = String(args.new_string ?? "");
      if (!oldStr) throw new Error("old_string is empty.");
      const text = (await readFile(file)).toString("utf8");
      const count = text.split(oldStr).length - 1;
      if (count === 0) throw new Error("old_string was not found in the file. Read the file again and match it exactly.");
      if (count > 1 && !args.replace_all) throw new Error(`old_string appears ${count} times. Use a longer, unique snippet, or pass replace_all.`);
      const next = args.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
      await writeFile(file, next);
      return { result: { path: String(args.path), replacements: args.replace_all ? count : 1 }, note: `${args.replace_all ? count : 1} replacement${(args.replace_all ? count : 1) === 1 ? "" : "s"}` };
    }
    case "write_file": {
      const file = await resolvePath(access, args.path, name);
      const content = String(args.content ?? "");
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error(`Content is larger than ${MAX_WRITE_BYTES / 1024} KB.`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      return { result: { path: String(args.path), bytes: Buffer.byteLength(content) }, note: `${Buffer.byteLength(content)} bytes` };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
