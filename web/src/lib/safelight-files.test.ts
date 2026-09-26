import path from "node:path";
import { describe, expect, it } from "vitest";
import { INPUT_DIR, OUTPUT_DIR, parseImageRef, safeJoin } from "./safelight-files";

const ROOT = "/srv/safelight/outputs";

describe("safeJoin", () => {
  it("joins inside the root", () => {
    expect(safeJoin(ROOT, "studio", "a.png")).toBe(path.join(ROOT, "studio", "a.png"));
    expect(safeJoin(ROOT, "a.png")).toBe(path.join(ROOT, "a.png"));
  });

  it("allows the root itself", () => {
    expect(safeJoin(ROOT)).toBe(ROOT);
  });

  it("refuses parent traversal", () => {
    expect(safeJoin(ROOT, "..", "secrets")).toBeNull();
    expect(safeJoin(ROOT, "studio", "..", "..", "secrets")).toBeNull();
    expect(safeJoin(ROOT, "foo/../../bar")).toBeNull();
  });

  it("refuses absolute escapes", () => {
    expect(safeJoin(ROOT, "/etc/passwd")).toBeNull();
    expect(safeJoin(ROOT, "//etc/passwd")).toBeNull();
  });

  it("does not treat lookalike dot names as traversal", () => {
    expect(safeJoin(ROOT, "..a", "b.png")).toBe(path.join(ROOT, "..a", "b.png"));
    expect(safeJoin(ROOT, "a..", "b.png")).toBe(path.join(ROOT, "a..", "b.png"));
  });

  it("refuses a sibling directory that shares the root's prefix", () => {
    expect(safeJoin(ROOT, "../outputs-evil/a.png")).toBeNull();
  });

  it("ignores empty segments", () => {
    expect(safeJoin(ROOT, "", "studio", "", "a.png")).toBe(path.join(ROOT, "studio", "a.png"));
  });
});

describe("parseImageRef", () => {
  it("defaults to the input directory", () => {
    expect(parseImageRef("studio/a.png")).toEqual({ dir: INPUT_DIR, subfolder: "studio", filename: "a.png" });
  });

  it("routes [output] refs to the output directory", () => {
    expect(parseImageRef("studio/qwen_0001.png [output]")).toEqual({ dir: OUTPUT_DIR, subfolder: "studio", filename: "qwen_0001.png" });
  });

  it("handles bare filenames", () => {
    expect(parseImageRef("a.png")).toEqual({ dir: INPUT_DIR, subfolder: "", filename: "a.png" });
  });

  it("keeps nested subfolders", () => {
    expect(parseImageRef("a/b/c.png [temp]").subfolder).toBe("a/b");
  });

  it("strips traversal from the filename via basename", () => {
    const parsed = parseImageRef("../../etc/passwd");
    expect(parsed.filename).toBe("passwd");
    // The subfolder still carries the traversal; consumers must run it through safeJoin.
    expect(safeJoin(INPUT_DIR, parsed.subfolder, parsed.filename)).toBeNull();
  });
});
