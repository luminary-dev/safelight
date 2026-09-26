import "server-only";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type { ToolDef } from "./tools";

const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_ENTRIES = 400;
const MAX_DEPTH = 6;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".venv", "venv", "__pycache__", "dist", "build", ".DS_Store"]);
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILE_BYTES = 512 * 1024;
const MAX_GLOB_RESULTS = 400;
// Search walks scan more files than a listing shows; keep them bounded but roomy.
const MAX_SEARCH_FILES = 5000;
const MAX_COMMAND_OUTPUT = 20000;
const execFileAsync = promisify(execFile);

export function codeSystemPrompt(root: string): string {
  return (
    `You are Safelight's coding assistant, working in the folder ${root} on the user's machine. ` +
    "You have tools: list_files to explore, glob to match paths by pattern, grep to search file contents by regex, read_file to look at code, edit_file for exact string replacements, multi_edit for an all-or-nothing batch of edits across files, write_file to create or overwrite a file, and delete_file / move_file to remove or relocate one. " +
    "Prefer grep to locate code before reading whole files, and glob over list_files when you know the path shape. Use multi_edit when one change spans several files so it lands atomically. " +
    "Paths outside the workspace are allowed only after the user approves each one, so prefer staying inside it. Always read a file before editing it, and make the smallest change that does the job. old_string must match the file exactly, including indentation. " +
    "run_command executes a shell command in the workspace, but only after the user approves that exact command — use it to run the project's own tests or build after editing, and prefer one meaningful command over many trivial ones. " +
    "After changing files, summarise briefly what you changed and where. If a request needs leaving the folder, the user must approve each outside path."
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
      name: "grep",
      description: "Search file contents recursively with a regular expression. Returns matching lines as { path, line, text }, capped at 200 matches. Skips binary files, files over 512 KB, and ignored folders.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "A JavaScript regular expression. Falls back to a literal text match if it does not compile." },
          path: { type: "string", description: "Folder to search, relative to the workspace root. Defaults to the root." },
          ignoreCase: { type: "boolean", description: "Case-insensitive matching." },
        },
        required: ["pattern"],
      },
    },
    {
      name: "glob",
      description: "Match workspace-relative file paths against a glob pattern. Supports * (within a segment), ** (any depth), and ? (one character). Returns up to 400 paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, e.g. src/**/*.ts" },
          path: { type: "string", description: "Folder to match under, relative to the workspace root. Defaults to the root." },
        },
        required: ["pattern"],
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
    {
      name: "multi_edit",
      description: "Apply several exact string replacements atomically, possibly across files. Every edit is validated first; if any old_string is missing or ambiguous, nothing is changed.",
      parameters: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            description: "Edits to apply in order. Each old_string must appear exactly once in its file (after earlier edits to the same file).",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "File path relative to the workspace root." },
                old_string: { type: "string", description: "The exact text to replace." },
                new_string: { type: "string", description: "The replacement text." },
              },
              required: ["path", "old_string", "new_string"],
            },
          },
        },
        required: ["edits"],
      },
    },
    {
      name: "delete_file",
      description: "Delete a single file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace root." },
        },
        required: ["path"],
      },
    },
    {
      name: "move_file",
      description: "Move or rename a file. Parent folders of the destination are created as needed.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Current file path relative to the workspace root." },
          to: { type: "string", description: "Destination path relative to the workspace root." },
        },
        required: ["from", "to"],
      },
    },
      {
      name: "run_command",
      description: "Run one shell command in the workspace. Every call pauses for the user's approval of the exact command. Returns exit code, stdout, and stderr.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command, executed with /bin/sh -c in the workspace folder." },
          timeout_seconds: { type: "number", description: "Kill the command after this long. Default 60, max 300." },
        },
        required: ["command"],
      },
    },
  ];
}

/** Hand-rolled glob → RegExp: `*` within a segment, `**` any depth, `?` one char. Exported for tests. */
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        // "**/x" also matches "x" at the top, so the globstar swallows its slash.
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:[^/]+/)*";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else {
      // Whitelist path-safe chars; escape everything else so "." and "(" stay literal.
      out += /[a-zA-Z0-9_\-/]/.test(c) ? c : "\\" + c;
    }
  }
  return new RegExp(out + "$");
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
  const rootRaw = path.resolve(access.root);
  // The root itself may live behind a symlink (macOS /tmp): canonicalise both sides before judging.
  const rootReal = await realpath(rootRaw).catch(() => rootRaw);
  const abs = path.resolve(rootRaw, typeof rel === "string" && rel ? rel : ".");
  // Judge by where the path really leads, so a symlink cannot smuggle access in either direction.
  const real = await realpath(abs).catch(() => abs);
  const approvedReal = await Promise.all(access.approved.map((a) => realpath(a).catch(() => a)));
  const insideRoots = within(real, rootRaw) || within(real, rootReal);
  const insideApproved = access.approved.some((a) => within(real, a)) || approvedReal.some((a) => within(real, a));
  if (insideRoots || insideApproved) return abs;
  const ok = await access.requestApproval(real, tool);
  if (!ok) throw new Error(`The user declined access to ${real}.`);
  access.approved.push(real);
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

/** Like walk, but files only and a higher cap: search tools scan more than a listing shows. */
async function walkFiles(dir: string, base: string, out: string[], depth: number): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_SEARCH_FILES) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (out.length >= MAX_SEARCH_FILES) return;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(full, base, out, depth + 1);
    else if (e.isFile()) out.push(path.relative(base, full));
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
    case "grep": {
      const dir = await resolvePath(access, args.path, name);
      const raw = String(args.pattern ?? "");
      if (!raw) throw new Error("pattern is empty.");
      const flags = args.ignoreCase ? "i" : "";
      let re: RegExp;
      try {
        re = new RegExp(raw, flags);
      } catch {
        // Not a valid RegExp: treat the pattern as literal text.
        re = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      }
      const files: string[] = [];
      await walkFiles(dir, dir, files, 0);
      const matches: { path: string; line: number; text: string }[] = [];
      for (const rel of files) {
        if (matches.length >= MAX_GREP_MATCHES) break;
        const full = path.join(dir, rel);
        const info = await stat(full).catch(() => null);
        if (!info || info.size > MAX_GREP_FILE_BYTES) continue;
        const buf = await readFile(full).catch(() => null);
        if (!buf || buf.includes(0)) continue; // NUL byte → binary
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
          if (re.test(lines[i])) matches.push({ path: rel, line: i + 1, text: lines[i].trimEnd().slice(0, 500) });
        }
      }
      return { result: { matches, truncated: matches.length >= MAX_GREP_MATCHES }, note: `${matches.length} match${matches.length === 1 ? "" : "es"}` };
    }
    case "glob": {
      const dir = await resolvePath(access, args.path, name);
      const raw = String(args.pattern ?? "");
      if (!raw) throw new Error("pattern is empty.");
      const re = globToRegExp(raw);
      const all: string[] = [];
      await walkFiles(dir, dir, all, 0);
      // Globs always use "/", whatever the platform separator is.
      const matched = all.map((f) => f.split(path.sep).join("/")).filter((f) => re.test(f));
      const files = matched.slice(0, MAX_GLOB_RESULTS);
      return { result: { files, truncated: matched.length > MAX_GLOB_RESULTS }, note: `${files.length} file${files.length === 1 ? "" : "s"}` };
    }
    case "multi_edit": {
      const edits = Array.isArray(args.edits) ? (args.edits as { path?: unknown; old_string?: unknown; new_string?: unknown }[]) : [];
      if (!edits.length) throw new Error("edits is empty.");
      // Two phases: validate everything (naming the failing path), then write, so a bad edit changes nothing.
      const staged = new Map<string, string>();
      for (const e of edits) {
        const rel = String(e?.path ?? "");
        const file = await resolvePath(access, e?.path, name);
        const oldStr = String(e?.old_string ?? "");
        if (!oldStr) throw new Error(`${rel}: old_string is empty.`);
        let text = staged.get(file);
        if (text === undefined) {
          const buf = await readFile(file).catch(() => null);
          if (buf === null) throw new Error(`${rel}: the file could not be read.`);
          if (buf.includes(0)) throw new Error(`${rel}: this looks like a binary file.`);
          text = buf.toString("utf8");
        }
        const count = text.split(oldStr).length - 1;
        if (count === 0) throw new Error(`${rel}: old_string was not found in the file.`);
        if (count > 1) throw new Error(`${rel}: old_string appears ${count} times; it must appear exactly once.`);
        staged.set(file, text.replace(oldStr, String(e?.new_string ?? "")));
      }
      for (const [file, next] of staged) await writeFile(file, next);
      const n = staged.size;
      return { result: { edits: edits.length, filesChanged: n }, note: `${n} file${n === 1 ? "" : "s"} changed` };
    }
    case "delete_file": {
      const file = await resolvePath(access, args.path, name);
      const info = await stat(file);
      if (!info.isFile()) throw new Error("Not a file.");
      await rm(file);
      return { result: { path: String(args.path), deleted: true }, note: "deleted" };
    }
    case "move_file": {
      const from = await resolvePath(access, args.from, name);
      const to = await resolvePath(access, args.to, name);
      const info = await stat(from);
      if (!info.isFile()) throw new Error("Not a file.");
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
      return { result: { from: String(args.from), to: String(args.to) }, note: "moved" };
    }
    case "run_command": {
      const command = String(args.command ?? "").trim();
      if (!command) throw new Error("Empty command.");
      // Every invocation is individually approved; there is deliberately no remember-this-command state.
      const ok = await access.requestApproval(command, "run_command");
      if (!ok) throw new Error("The user declined to run that command.");
      const cwd = await realpath(path.resolve(access.root)).catch(() => path.resolve(access.root));
      const timeout = Math.min(Math.max(1, Number(args.timeout_seconds) || 60), 300) * 1000;
      const clip = (t: string) => (t.length > MAX_COMMAND_OUTPUT ? t.slice(0, MAX_COMMAND_OUTPUT) + "\n…truncated" : t);
      try {
        // Scrubbed environment: the child never sees the server's env (keys, vault material).
        const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", command], {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? cwd, LANG: "en_US.UTF-8" } as unknown as NodeJS.ProcessEnv,
        });
        return { result: { exitCode: 0, stdout: clip(stdout), stderr: clip(stderr) }, note: "exit 0" };
      } catch (err) {
        const e = err as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
        if (e.killed) return { result: { exitCode: null, stdout: clip(e.stdout ?? ""), stderr: clip(e.stderr ?? ""), timedOut: true }, note: "timed out" };
        const exitCode = typeof e.code === "number" ? e.code : 1;
        return { result: { exitCode, stdout: clip(e.stdout ?? ""), stderr: clip(e.stderr ?? "") }, note: `exit ${exitCode}` };
      }
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
