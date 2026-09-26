import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { executeCodeTool, resolvePath, type CodeAccess } from "./code-tools";

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
