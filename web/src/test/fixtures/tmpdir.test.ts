import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestRoot, type TestRoot } from "./tmpdir";

let root: TestRoot | null = null;

afterEach(async () => {
  await root?.cleanup();
  root = null;
  vi.restoreAllMocks();
});

describe("tmpdir fixture", () => {
  it("creates data/inputs/outputs and wires the SAFELIGHT_*/COMFY_* envs", async () => {
    root = await makeTestRoot();
    expect(existsSync(root.dataDir)).toBe(true);
    expect(existsSync(root.inputsDir)).toBe(true);
    expect(existsSync(root.outputsDir)).toBe(true);
    expect(process.env.SAFELIGHT_DATA_DIR).toBe(root.dataDir);
    expect(process.env.COMFY_OUTPUT_DIR).toBe(root.outputsDir);
    expect(process.env.COMFY_INPUT_DIR).toBe(root.inputsDir);
    expect(root.dataDir).toBeWithinDirectory(root.root);
  });

  it("cleanup removes the tree and restores prior env values", async () => {
    const before = process.env.SAFELIGHT_DATA_DIR;
    root = await makeTestRoot();
    const dir = root.root;
    await root.cleanup();
    expect(existsSync(dir)).toBe(false);
    expect(process.env.SAFELIGHT_DATA_DIR).toBe(before);
    root = null;
  });

  it("two roots never collide", async () => {
    root = await makeTestRoot();
    const first = root.root;
    const second = await makeTestRoot();
    expect(second.root).not.toBe(first);
    await second.cleanup();
  });

  it("allows writes inside the root and in the OS tempdir", async () => {
    root = await makeTestRoot();
    await writeFile(path.join(root.outputsDir, "a.png"), "x");
    await mkdir(path.join(root.dataDir, "backups"), { recursive: true });
    await writeFile(path.join(tmpdir(), "safelight-guard-probe.txt"), "x");
    expect(root.strayWrites()).toEqual([]);
    root.assertNoStrayWrites();
  });

  it("flags a property-style fs write that escapes the sandbox, still performing it unchanged", async () => {
    root = await makeTestRoot();
    const fs = (await import("node:fs")).default;
    const outside = path.join(process.cwd(), "test-results", `stray-${Date.now()}.txt`);
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, "oops"); // property access — the style the spies can see
    expect(fs.existsSync(outside)).toBe(true); // wrap, never block
    fs.rmSync(outside, { force: true });
    expect(root.strayWrites()).toContain(path.resolve(outside));
    expect(() => root!.assertNoStrayWrites()).toThrow(/escaped the test root/);
  });

  it("documented boundary: a named ESM import of node:fs/promises bypasses the spies", async () => {
    root = await makeTestRoot();
    const outside = path.join(process.cwd(), "test-results", `stray-esm-${Date.now()}.txt`);
    await writeFile(outside, "invisible to the guard"); // named import, statically bound
    const { rmSync } = await import("node:fs");
    rmSync(outside, { force: true });
    // This is the guard's stated limitation — if it ever starts catching these,
    // the docs in tmpdir.ts should be updated to claim the stronger guarantee.
    expect(root.strayWrites()).not.toContain(path.resolve(outside));
  });

  it("fails when a managed env var is repointed outside the sandbox", async () => {
    root = await makeTestRoot();
    process.env.SAFELIGHT_DATA_DIR = "/somewhere/else";
    expect(() => root!.assertNoStrayWrites()).toThrow(/Env vars escaped/);
    process.env.SAFELIGHT_DATA_DIR = root.dataDir;
    root.assertNoStrayWrites();
  });
});
