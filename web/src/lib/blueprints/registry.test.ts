import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Registry cache + failure isolation (TEST-BRIEF §10 — registry.ts was at 0 %).
 * BLUEPRINTS_DIR is read from the env at module load, so every test imports a
 * fresh module instance pointed at its own throwaway folder.
 */

const FIXTURES = path.join(__dirname, "fixtures");

let dir: string;

async function registryAt(folder: string) {
  vi.resetModules();
  process.env.BLUEPRINTS_DIR = folder;
  return await import("./registry");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sl-bp-"));
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.BLUEPRINTS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("blueprintId", () => {
  it("normalizes file names to stable slugs", async () => {
    const { blueprintId } = await registryAt(dir);
    expect(blueprintId("Text to Image (Z-Image-Turbo).json")).toBe("text-to-image-z-image-turbo");
    expect(blueprintId("Image Blur.JSON")).toBe("image-blur");
    expect(blueprintId("--Weird__ Name--.json")).toBe("weird-name");
  });
});

describe("getRegistry", () => {
  it("parses every JSON file in the folder into blueprints with ids from their names", async () => {
    copyFileSync(path.join(FIXTURES, "Image Blur.json"), path.join(dir, "Image Blur.json"));
    copyFileSync(path.join(FIXTURES, "Text to Image (Z-Image-Turbo).json"), path.join(dir, "Text to Image (Z-Image-Turbo).json"));
    const { getRegistry, getBlueprint } = await registryAt(dir);
    const reg = await getRegistry();
    expect(reg.failures).toEqual([]);
    expect(reg.blueprints.map((b) => b.spec.id).sort()).toEqual(["image-blur", "text-to-image-z-image-turbo"]);
    expect((await getBlueprint("image-blur"))?.spec.name).toBe("Image Blur");
    expect(await getBlueprint("nope")).toBeUndefined();
  });

  it("a malformed file and a truncated one land in failures without sinking the rest", async () => {
    copyFileSync(path.join(FIXTURES, "Image Blur.json"), path.join(dir, "Image Blur.json"));
    writeFileSync(path.join(dir, "broken.json"), "{ not json at all");
    writeFileSync(path.join(dir, "truncated.json"), JSON.stringify({ nodes: "gone" })); // valid JSON, not a workflow
    // A file truncated past its subgraph definitions still parses (the uuid
    // class survives for the gate to flag) — see parse.test.ts; it must not
    // count as a registry failure.
    writeFileSync(path.join(dir, "half-a-graph.json"), JSON.stringify({ nodes: [{ id: 1, type: "11111111-2222-4333-8444-555555555555" }] }));
    const { getRegistry } = await registryAt(dir);
    const reg = await getRegistry();
    expect(reg.blueprints.map((b) => b.spec.id).sort()).toEqual(["half-a-graph", "image-blur"]);
    expect(reg.failures.map((f) => f.file).sort()).toEqual(["broken.json", "truncated.json"]);
    expect(reg.failures.find((f) => f.file === "truncated.json")?.error).toMatch(/missing nodes array/i);
    expect(reg.failures.find((f) => f.file === "broken.json")?.error).toBeTruthy();
  });

  it("colliding slugs get a numeric suffix instead of shadowing each other", async () => {
    copyFileSync(path.join(FIXTURES, "Image Blur.json"), path.join(dir, "Image Blur.json"));
    copyFileSync(path.join(FIXTURES, "Image Blur.json"), path.join(dir, "Image  Blur.json")); // same slug after normalization
    const { getRegistry } = await registryAt(dir);
    const reg = await getRegistry();
    expect(reg.blueprints.map((b) => b.spec.id).sort()).toEqual(["image-blur", "image-blur-2"]);
  });

  it("a missing folder is a single failure entry, not a throw", async () => {
    const { getRegistry } = await registryAt(path.join(dir, "does-not-exist"));
    const reg = await getRegistry();
    expect(reg.blueprints).toEqual([]);
    expect(reg.failures).toEqual([{ file: path.join(dir, "does-not-exist"), error: "Blueprints folder not found." }]);
  });

  it("caches the parsed folder briefly and re-reads after the TTL", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z").getTime() });
    copyFileSync(path.join(FIXTURES, "Image Blur.json"), path.join(dir, "Image Blur.json"));
    const { getRegistry } = await registryAt(dir);
    expect((await getRegistry()).blueprints).toHaveLength(1);

    copyFileSync(path.join(FIXTURES, "Text to Image (Z-Image-Turbo).json"), path.join(dir, "Text to Image (Z-Image-Turbo).json"));
    expect((await getRegistry()).blueprints).toHaveLength(1); // inside the TTL: cached

    vi.advanceTimersByTime(61_000);
    expect((await getRegistry()).blueprints).toHaveLength(2); // TTL expired: folder re-read
  });
});
