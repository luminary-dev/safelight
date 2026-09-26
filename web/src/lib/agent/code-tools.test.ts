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
