import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { executeCodeTool, globToRegExp, resolvePath, type CodeAccess } from "./code-tools";

let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sl-root-"));
  outside = await mkdtemp(path.join(tmpdir(), "sl-outside-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "const greeting = 'Helo';\nexport default greeting;\n");
  await writeFile(path.join(outside, "note.txt"), "outside\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function access(overrides?: Partial<CodeAccess>): CodeAccess {
  return { root, approved: [], requestApproval: vi.fn(async () => false), ...overrides };
}

describe("resolvePath", () => {
  it("resolves inside the root without asking", async () => {
    const a = access();
    await expect(resolvePath(a, "src/a.ts", "read_file")).resolves.toBe(path.join(root, "src", "a.ts"));
    expect(a.requestApproval).not.toHaveBeenCalled();
  });

  it("asks for anything outside and throws on deny", async () => {
    const a = access();
    await expect(resolvePath(a, path.join(outside, "note.txt"), "read_file")).rejects.toThrow(/declined access/);
    expect(a.requestApproval).toHaveBeenCalledOnce();
  });

  it("proceeds on approval and remembers it for the run", async () => {
    const ask = vi.fn(async () => true);
    const a = access({ requestApproval: ask });
    const target = path.join(outside, "note.txt");
    await expect(resolvePath(a, target, "read_file")).resolves.toBe(target);
    await expect(resolvePath(a, target, "read_file")).resolves.toBe(target);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("an approved folder covers its subtree without re-asking", async () => {
    const ask = vi.fn(async () => true);
    const a = access({ approved: [outside], requestApproval: ask });
    await expect(resolvePath(a, path.join(outside, "note.txt"), "read_file")).resolves.toBe(path.join(outside, "note.txt"));
    expect(ask).not.toHaveBeenCalled();
  });

  it("a prefix-lookalike sibling is still outside", async () => {
    const ask = vi.fn(async () => false);
    const a = access({ approved: [outside], requestApproval: ask });
    await expect(resolvePath(a, `${outside}-evil/x`, "read_file")).rejects.toThrow(/declined access/);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("relative traversal out of the root asks", async () => {
    const a = access();
    await expect(resolvePath(a, "../whatever", "read_file")).rejects.toThrow(/declined access/);
  });
});

describe("executeCodeTool", () => {
  it("reads with numbered lines", async () => {
    const { result } = await executeCodeTool("read_file", { path: "src/a.ts" }, access());
    expect((result as { content: string }).content).toContain("1\tconst greeting");
  });

  it("edit requires a unique match", async () => {
    await writeFile(path.join(root, "dup.txt"), "x\nx\n");
    await expect(executeCodeTool("edit_file", { path: "dup.txt", old_string: "x", new_string: "y" }, access())).rejects.toThrow(/appears 2 times/);
  });

  it("edit replaces exactly and writes to disk", async () => {
    await executeCodeTool("edit_file", { path: "src/a.ts", old_string: "'Helo'", new_string: "'Hello'" }, access());
    expect(await readFile(path.join(root, "src", "a.ts"), "utf8")).toContain("'Hello'");
  });

  it("edit with a missing old_string names the problem", async () => {
    await expect(executeCodeTool("edit_file", { path: "src/a.ts", old_string: "nope", new_string: "x" }, access())).rejects.toThrow(/not found/);
  });

  it("write_file creates parents", async () => {
    await executeCodeTool("write_file", { path: "deep/new/file.txt", content: "hi" }, access());
    expect(await readFile(path.join(root, "deep", "new", "file.txt"), "utf8")).toBe("hi");
  });

  it("list_files skips ignored folders", async () => {
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    const { result } = await executeCodeTool("list_files", {}, access());
    const files = (result as { files: string[] }).files;
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files).toContain(path.join("src", "a.ts"));
  });
});

describe("glob", () => {
  it("translates src/*.ts, **/*.ts and a?.ts correctly", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false);
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("src/deep/a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("src/a.txt")).toBe(false);
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("a?.ts").test("a.ts")).toBe(false);
    expect(globToRegExp("a?.ts").test("ab/c.ts")).toBe(false);
  });

  it("matches workspace files and caps results", async () => {
    const { result } = await executeCodeTool("glob", { pattern: "src/*.ts" }, access());
    expect((result as { files: string[] }).files).toContain("src/a.ts");
  });

  it("outside the root asks for approval and rejects on deny", async () => {
    const a = access();
    await expect(executeCodeTool("glob", { pattern: "*.txt", path: outside }, a)).rejects.toThrow(/declined access/);
    expect(a.requestApproval).toHaveBeenCalledOnce();
  });
});

describe("grep", () => {
  it("finds a known line with path, line and text", async () => {
    const { result } = await executeCodeTool("grep", { pattern: "greeting" }, access());
    const matches = (result as { matches: { path: string; line: number; text: string }[] }).matches;
    const hit = matches.find((m) => m.path === path.join("src", "a.ts"));
    expect(hit).toBeDefined();
    expect(hit!.line).toBe(1);
    expect(hit!.text).toContain("greeting");
  });

  it("respects ignoreCase", async () => {
    const miss = await executeCodeTool("grep", { pattern: "GREETING" }, access());
    expect((miss.result as { matches: unknown[] }).matches).toHaveLength(0);
    const hit = await executeCodeTool("grep", { pattern: "GREETING", ignoreCase: true }, access());
    expect((hit.result as { matches: unknown[] }).matches.length).toBeGreaterThan(0);
  });

  it("skips node_modules", async () => {
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "pkg", "hit.txt"), "greeting inside node_modules\n");
    const { result } = await executeCodeTool("grep", { pattern: "greeting" }, access());
    const matches = (result as { matches: { path: string }[] }).matches;
    expect(matches.some((m) => m.path.includes("node_modules"))).toBe(false);
  });

  it("outside the root asks for approval and rejects on deny", async () => {
    const a = access();
    await expect(executeCodeTool("grep", { pattern: "outside", path: outside }, a)).rejects.toThrow(/declined access/);
    expect(a.requestApproval).toHaveBeenCalledOnce();
  });
});

describe("multi_edit", () => {
  it("applies nothing when a later edit fails validation", async () => {
    await writeFile(path.join(root, "m1.txt"), "alpha\n");
    await writeFile(path.join(root, "m2.txt"), "beta\n");
    await expect(
      executeCodeTool(
        "multi_edit",
        {
          edits: [
            { path: "m1.txt", old_string: "alpha", new_string: "ALPHA" },
            { path: "m2.txt", old_string: "nope", new_string: "x" },
          ],
        },
        access(),
      ),
    ).rejects.toThrow(/m2\.txt.*not found/);
    // Atomicity: the valid first edit must not have landed.
    expect(await readFile(path.join(root, "m1.txt"), "utf8")).toBe("alpha\n");
  });

  it("applies all edits when every one validates", async () => {
    const { note } = await executeCodeTool(
      "multi_edit",
      {
        edits: [
          { path: "m1.txt", old_string: "alpha", new_string: "ALPHA" },
          { path: "m2.txt", old_string: "beta", new_string: "BETA" },
        ],
      },
      access(),
    );
    expect(note).toBe("2 files changed");
    expect(await readFile(path.join(root, "m1.txt"), "utf8")).toBe("ALPHA\n");
    expect(await readFile(path.join(root, "m2.txt"), "utf8")).toBe("BETA\n");
  });
});

describe("delete_file and move_file", () => {
  it("deletes a file, then a move round-trips content into a new folder", async () => {
    await writeFile(path.join(root, "gone.txt"), "bye");
    await executeCodeTool("delete_file", { path: "gone.txt" }, access());
    await expect(readFile(path.join(root, "gone.txt"), "utf8")).rejects.toThrow();

    await writeFile(path.join(root, "moveme.txt"), "mv");
    await executeCodeTool("move_file", { from: "moveme.txt", to: "moved/deep/target.txt" }, access());
    expect(await readFile(path.join(root, "moved", "deep", "target.txt"), "utf8")).toBe("mv");
    await expect(readFile(path.join(root, "moveme.txt"), "utf8")).rejects.toThrow();
  });
});

describe("run_command", () => {
  it("never runs without approval", async () => {
    const ask = vi.fn(async () => false);
    await expect(executeCodeTool("run_command", { command: "echo hi" }, access({ requestApproval: ask }))).rejects.toThrow(/declined to run/);
    expect(ask).toHaveBeenCalledWith("echo hi", "run_command");
  });

  it("runs an approved command in the workspace and captures output", async () => {
    const a = access({ requestApproval: vi.fn(async () => true) });
    const { result, note } = await executeCodeTool("run_command", { command: "echo hello && pwd" }, a);
    const r = result as { exitCode: number; stdout: string };
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
    expect(note).toBe("exit 0");
  });

  it("returns a nonzero exit code instead of throwing", async () => {
    const a = access({ requestApproval: vi.fn(async () => true) });
    const { result, note } = await executeCodeTool("run_command", { command: "exit 3" }, a);
    expect((result as { exitCode: number }).exitCode).toBe(3);
    expect(note).toBe("exit 3");
  });

  it("scrubs the environment so server secrets never reach the child", async () => {
    process.env.SAFELIGHT_TEST_SECRET = "leak-me-not";
    try {
      const a = access({ requestApproval: vi.fn(async () => true) });
      const { result } = await executeCodeTool("run_command", { command: "env" }, a);
      expect((result as { stdout: string }).stdout).not.toContain("leak-me-not");
    } finally {
      delete process.env.SAFELIGHT_TEST_SECRET;
    }
  });
});

// ---------------------------------------------------------------------------
// TEST-BRIEF §9 extensions: edit_file matching modes, read_file caps and
// paging, write_file caps, list_files bounds, and the escape suite.

import { symlink } from "node:fs/promises";
import { beforeAll as beforeAllHook } from "vitest";

describe("edit_file matching modes", () => {
  it("replace_all rewrites every occurrence and reports the count", async () => {
    await writeFile(path.join(root, "all2.txt"), "aXa\naXa\naXa\n");
    const { result, note } = await executeCodeTool("edit_file", { path: "all2.txt", old_string: "aXa", new_string: "b", replace_all: true }, access());
    expect(result).toMatchObject({ replacements: 3 });
    expect(note).toBe("3 replacements");
    expect(await readFile(path.join(root, "all2.txt"), "utf8")).toBe("b\nb\nb\n");
  });

  it("matches CRLF line endings byte-exactly", async () => {
    await writeFile(path.join(root, "crlf.txt"), "first\r\nsecond\r\nthird\r\n");
    await executeCodeTool("edit_file", { path: "crlf.txt", old_string: "first\r\nsecond", new_string: "FIRST\r\nSECOND" }, access());
    expect(await readFile(path.join(root, "crlf.txt"), "utf8")).toBe("FIRST\r\nSECOND\r\nthird\r\n");
    // An LF-only old_string must NOT match a CRLF file.
    await expect(executeCodeTool("edit_file", { path: "crlf.txt", old_string: "SECOND\nthird", new_string: "x" }, access())).rejects.toThrow(/not found/);
  });

  it("matches across newlines", async () => {
    await writeFile(path.join(root, "multi.txt"), "function a() {\n  return 1;\n}\n");
    await executeCodeTool("edit_file", { path: "multi.txt", old_string: "a() {\n  return 1;", new_string: "a() {\n  return 2;" }, access());
    expect(await readFile(path.join(root, "multi.txt"), "utf8")).toContain("return 2;");
  });

  it("rejects an empty old_string", async () => {
    await expect(executeCodeTool("edit_file", { path: "src/a.ts", old_string: "", new_string: "x" }, access())).rejects.toThrow("old_string is empty.");
  });
});

describe("read_file caps and paging", () => {
  it("refuses files over the 256 KB cap, naming both sizes", async () => {
    await writeFile(path.join(root, "big.txt"), "a".repeat(257 * 1024));
    await expect(executeCodeTool("read_file", { path: "big.txt" }, access())).rejects.toThrow(/257 KB.*only files up to 256 KB/);
  });

  it("detects binary files by NUL byte", async () => {
    await writeFile(path.join(root, "blob.bin"), Buffer.from([0x41, 0x00, 0x42]));
    await expect(executeCodeTool("read_file", { path: "blob.bin" }, access())).rejects.toThrow("This looks like a binary file.");
  });

  it("pages with offset and limit, numbering from the offset", async () => {
    await writeFile(path.join(root, "pages.txt"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"));
    const { result, note } = await executeCodeTool("read_file", { path: "pages.txt", offset: 5, limit: 2 }, access());
    expect((result as { content: string }).content).toBe("5\tline 5\n6\tline 6");
    expect((result as { totalLines: number }).totalLines).toBe(10);
    expect(note).toBe("2 lines");
  });

  it("paging past EOF returns zero lines rather than failing", async () => {
    await writeFile(path.join(root, "short.txt"), "only\n");
    const { result, note } = await executeCodeTool("read_file", { path: "short.txt", offset: 100 }, access());
    expect((result as { content: string }).content).toBe("");
    expect(note).toBe("0 lines");
  });

  it("refuses a directory", async () => {
    await expect(executeCodeTool("read_file", { path: "src" }, access())).rejects.toThrow("Not a file.");
  });
});

describe("write_file cap", () => {
  it("refuses content over 512 KB and writes nothing", async () => {
    await expect(executeCodeTool("write_file", { path: "huge.txt", content: "a".repeat(513 * 1024) }, access())).rejects.toThrow(/larger than 512 KB/);
    await expect(readFile(path.join(root, "huge.txt"), "utf8")).rejects.toThrow();
  });
});

describe("list_files bounds", () => {
  it("stops at the depth cap: entries deeper than 6 levels are invisible", async () => {
    const deepPath = path.join("depth", "d1", "d2", "d3", "d4", "d5", "d6", "d7");
    await mkdir(path.join(root, deepPath), { recursive: true });
    await writeFile(path.join(root, deepPath, "too-deep.txt"), "x");
    await writeFile(path.join(root, "depth", "d1", "d2", "d3", "d4", "d5", "d6", "visible.txt"), "x");
    const { result } = await executeCodeTool("list_files", { path: "depth" }, access());
    const files = (result as { files: string[] }).files;
    expect(files).toContain(path.join("d1", "d2", "d3", "d4", "d5", "d6", "visible.txt"));
    expect(files.some((f) => f.includes("too-deep"))).toBe(false);
  });

  it("caps entries at 400 and sets the truncated flag", async () => {
    await mkdir(path.join(root, "many"), { recursive: true });
    await Promise.all(Array.from({ length: 420 }, (_, i) => writeFile(path.join(root, "many", `f${String(i).padStart(3, "0")}.txt`), "x")));
    const { result } = await executeCodeTool("list_files", { path: "many" }, access());
    const r = result as { files: string[]; truncated: boolean };
    expect(r.files).toHaveLength(400);
    expect(r.truncated).toBe(true);
  });

  it("filters with a case-insensitive pattern", async () => {
    const { result } = await executeCodeTool("list_files", { path: "src", pattern: "A.TS" }, access());
    expect((result as { files: string[] }).files).toContain("a.ts");
    const miss = await executeCodeTool("list_files", { path: "src", pattern: "NOPE" }, access());
    expect((miss.result as { files: string[] }).files).toEqual([]);
  });

  it("skips every SKIP_DIRS folder, not only node_modules", async () => {
    for (const dir of [".git", ".next", "__pycache__", "dist"]) {
      await mkdir(path.join(root, "skipdirs", dir), { recursive: true });
      await writeFile(path.join(root, "skipdirs", dir, "hidden.txt"), "x");
    }
    await writeFile(path.join(root, "skipdirs", "kept.txt"), "x");
    const { result } = await executeCodeTool("list_files", { path: "skipdirs" }, access());
    expect((result as { files: string[] }).files).toEqual(["kept.txt"]);
  });
});

// ---------------------------------------------------------------------------
// The escape suite (TEST-BRIEF §9): ../../etc/passwd, /etc/passwd, a symlink
// out of the root, and ./a/../../out must hit the approval gate for EVERY tool.

describe("the escape suite", () => {
  beforeAllHook(async () => {
    await symlink(path.join(outside, "note.txt"), path.join(root, "sneaky-link"));
  });

  const ESCAPES: [string, string][] = [
    ["relative traversal", "../../etc/passwd"],
    ["absolute path", "/etc/passwd"],
    ["dot-path traversal", "./a/../../escape-target"],
    ["symlink out of the root", "sneaky-link"],
  ];

  const TOOLS: [string, (p: string) => Record<string, unknown>][] = [
    ["list_files", (p) => ({ path: p })],
    ["read_file", (p) => ({ path: p })],
    ["edit_file", (p) => ({ path: p, old_string: "x", new_string: "y" })],
    ["write_file", (p) => ({ path: p, content: "x" })],
    ["grep", (p) => ({ pattern: "x", path: p })],
    ["glob", (p) => ({ pattern: "*", path: p })],
    ["multi_edit", (p) => ({ edits: [{ path: p, old_string: "x", new_string: "y" }] })],
    ["delete_file", (p) => ({ path: p })],
    ["move_file", (p) => ({ from: p, to: "safe.txt" })],
  ];

  const CASES = TOOLS.flatMap(([tool, argsOf]) => ESCAPES.map(([label, p]): [string, string, string, (q: string) => Record<string, unknown>] => [tool, label, p, argsOf]));

  it.each(CASES)("%s gates %s and refuses on deny", async (tool, _label, p, argsOf) => {
    const ask = vi.fn<CodeAccess["requestApproval"]>(async () => false);
    const a = access({ requestApproval: ask });
    await expect(executeCodeTool(tool, argsOf(p), a)).rejects.toThrow(/declined access/);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0][1]).toBe(tool);
  });

  it("move_file gates an escaping destination even when the source is inside", async () => {
    await writeFile(path.join(root, "stay.txt"), "x");
    for (const [, p] of ESCAPES) {
      const ask = vi.fn(async () => false);
      await expect(executeCodeTool("move_file", { from: "stay.txt", to: p }, access({ requestApproval: ask }))).rejects.toThrow(/declined access/);
      expect(ask).toHaveBeenCalledOnce();
    }
  });

  it("the gate receives the CANONICAL target of a symlink, not the in-root alias", async () => {
    const ask = vi.fn<CodeAccess["requestApproval"]>(async () => false);
    await expect(executeCodeTool("read_file", { path: "sneaky-link" }, access({ requestApproval: ask }))).rejects.toThrow(/declined access/);
    const asked = ask.mock.calls[0][0];
    expect(asked).not.toContain("sneaky-link");
    expect(asked).toContain("note.txt");
  });

  it("run_command always gates, whatever the path arguments say", async () => {
    const ask = vi.fn(async () => false);
    await expect(executeCodeTool("run_command", { command: "cat /etc/passwd" }, access({ requestApproval: ask }))).rejects.toThrow(/declined to run/);
    expect(ask).toHaveBeenCalledWith("cat /etc/passwd", "run_command");
  });
});
