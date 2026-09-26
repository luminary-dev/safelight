import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { scanLibrary } from "./index";
import { searchLibrary, setFavorite, updateTags } from "./search";
import { noisePng } from "./test-images";
import { thumbPathFor } from "./thumbs";

let dataDir: string;
let outputs: string;

const SIDECAR = {
  v: 1,
  kind: "safelight-render",
  mode: "txt2img",
  model: { name: "qwen-image-2.1-q4.gguf", folder: "unet_gguf" },
  prompt: "soft linen morning light over a quiet table",
  negativePrompt: "",
  seed: 42,
  sampler: "euler",
  scheduler: "simple",
  steps: 25,
  cfg: 4,
  width: 1024,
  height: 1024,
  denoise: 1,
  images: [],
  createdAt: 1758800000000,
};

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "sl-lib-data-"));
  outputs = await mkdtemp(path.join(tmpdir(), "sl-lib-out-"));
  process.env.SAFELIGHT_DATA_DIR = dataDir;
  resetDbForTests();
  await mkdir(path.join(outputs, "sub"), { recursive: true });
  await writeFile(path.join(outputs, "a.png"), await noisePng(1));
  await writeFile(path.join(outputs, "sub", "b.png"), await noisePng(2));
  await writeFile(path.join(outputs, "sub", "b.png.json"), JSON.stringify(SIDECAR));
  await writeFile(path.join(outputs, "c.png"), await noisePng(3));
  await writeFile(path.join(outputs, "c.png.json"), "not json {{{{");
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
  await rm(outputs, { recursive: true, force: true });
});

describe("library indexer", () => {
  it("round-trips a fresh outputs folder into rows with dimensions, hashes and thumbs", async () => {
    const result = await scanLibrary(outputs);
    expect(result).toEqual({ added: 3, updated: 0, removed: 0 });

    const { items, total } = searchLibrary({});
    expect(total).toBe(3);
    const a = items.find((i) => i.path === "a.png")!;
    expect(a.width).toBe(32);
    expect(a.height).toBe(32);
    expect(existsSync(thumbPathFor("a.png"))).toBe(true);

    const b = items.find((i) => i.path === "sub/b.png")!;
    expect(b.model).toBe("qwen-image-2.1-q4.gguf");
    expect(b.seed).toBe(42);
    expect(b.prompt).toContain("linen");
    expect(JSON.parse(b.meta!)).toMatchObject({ kind: "safelight-render", steps: 25 });

    // Garbage sidecar still indexes the file, just unenriched.
    const c = items.find((i) => i.path === "c.png")!;
    expect(c.model).toBeNull();
    expect(c.meta).toBeNull();
  });

  it("is incremental: unchanged files are skipped, changed ones re-read, vanished ones dropped", async () => {
    await scanLibrary(outputs);
    expect(await scanLibrary(outputs)).toEqual({ added: 0, updated: 0, removed: 0 });

    await writeFile(path.join(outputs, "a.png"), await noisePng(9, 48, 48));
    await utimes(path.join(outputs, "a.png"), new Date(), new Date(Date.now() + 5000));
    await unlink(path.join(outputs, "c.png"));
    const result = await scanLibrary(outputs);
    expect(result).toEqual({ added: 0, updated: 1, removed: 1 });

    const { items, total } = searchLibrary({});
    expect(total).toBe(2);
    expect(items.find((i) => i.path === "a.png")!.width).toBe(48);
    expect(existsSync(thumbPathFor("c.png"))).toBe(false);
  });

  it("keeps favorites and tags across a re-index of the same path", async () => {
    await scanLibrary(outputs);
    expect(setFavorite("a.png", true)).toBe(true);
    expect(updateTags("a.png", ["hero"], [])).toEqual(["hero"]);

    await writeFile(path.join(outputs, "a.png"), await noisePng(7));
    await utimes(path.join(outputs, "a.png"), new Date(), new Date(Date.now() + 5000));
    await scanLibrary(outputs);

    const { items } = searchLibrary({ fav: true });
    expect(items.map((i) => i.path)).toEqual(["a.png"]);
    expect(items[0].tags).toEqual(["hero"]);
  });

  it("answers prompt search through FTS with prefix matching, plus filters and facets", async () => {
    await scanLibrary(outputs);

    expect(searchLibrary({ q: "linen" }).items.map((i) => i.path)).toEqual(["sub/b.png"]);
    expect(searchLibrary({ q: "lin morn" }).items.map((i) => i.path)).toEqual(["sub/b.png"]); // prefixes
    expect(searchLibrary({ q: "cathedral" }).total).toBe(0);
    expect(searchLibrary({ q: 'weird "quotes" AND (stuff' }).total).toBe(0); // sanitised, no throw

    expect(searchLibrary({ model: "qwen-image-2.1-q4.gguf" }).total).toBe(1);
    updateTags("c.png", ["test-tag"], []);
    const tagged = searchLibrary({ tag: "test-tag" });
    expect(tagged.items.map((i) => i.path)).toEqual(["c.png"]);

    const facets = searchLibrary({}).facets;
    expect(facets.models).toEqual([{ value: "qwen-image-2.1-q4.gguf", count: 1 }]);
    expect(facets.tags).toEqual([{ value: "test-tag", count: 1 }]);
  });

  it("sorts newest, oldest and largest with date-range filters on mtime", async () => {
    await scanLibrary(outputs);
    const now = Date.now();
    const old = new Date(now - 10 * 86_400_000);
    await utimes(path.join(outputs, "a.png"), old, old);
    await scanLibrary(outputs);

    const newest = searchLibrary({ sort: "newest" }).items.map((i) => i.path);
    expect(newest[newest.length - 1]).toBe("a.png");
    expect(searchLibrary({ sort: "oldest" }).items[0].path).toBe("a.png");

    const bySize = searchLibrary({ sort: "largest" }).items;
    for (let i = 1; i < bySize.length; i++) expect(bySize[i - 1].size).toBeGreaterThanOrEqual(bySize[i].size);

    const lastWeek = searchLibrary({ from: String(now - 7 * 86_400_000) });
    expect(lastWeek.items.map((i) => i.path).sort()).toEqual(["c.png", "sub/b.png"]);
    expect(searchLibrary({ to: String(now - 7 * 86_400_000) }).items.map((i) => i.path)).toEqual(["a.png"]);
  });
});
