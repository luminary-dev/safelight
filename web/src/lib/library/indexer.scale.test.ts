import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db";
import { scanLibrary } from "./index";
import { duplicateGroups, searchLibrary } from "./search";
import { noisePng, stripePng } from "./test-images";
import { thumbPathFor } from "./thumbs";

/**
 * Indexer at scale (TEST-BRIEF §10): ~300 real files across nested folders,
 * kept fast with tiny PNGs — the sweep plus assertions must stay well under
 * the 10 s budget. Also: incremental re-index after a bulk change, a corrupt
 * source image inside the big tree, and dHash duplicate grouping with
 * false-positive resistance on the indexed rows.
 */

const COUNT = 300;

let dataDir: string;
let outputs: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "sl-scale-data-"));
  outputs = await mkdtemp(path.join(tmpdir(), "sl-scale-out-"));
  process.env.SAFELIGHT_DATA_DIR = dataDir;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
  await rm(outputs, { recursive: true, force: true });
});

it("indexes ~300 files in one sweep, incrementally re-indexes, and survives a corrupt image — under 10s", async () => {
  // 6 distinct tiny images reused across 300 paths keeps generation cheap and
  // gives the duplicate grouper something honest to chew on.
  const pool = await Promise.all([noisePng(1), noisePng(2), noisePng(3), noisePng(4), noisePng(5), noisePng(6)]);
  const started = Date.now();
  const writes: Promise<unknown>[] = [];
  for (let d = 0; d < 10; d++) writes.push(mkdir(path.join(outputs, `batch-${d}`), { recursive: true }));
  await Promise.all(writes);
  const fileWrites: Promise<unknown>[] = [];
  for (let i = 0; i < COUNT; i++) {
    const rel = path.join(`batch-${i % 10}`, `render_${String(i).padStart(4, "0")}_.png`);
    fileWrites.push(writeFile(path.join(outputs, rel), pool[i % pool.length]));
    if (i % 3 === 0) {
      fileWrites.push(
        writeFile(
          path.join(outputs, `${rel}.json`),
          JSON.stringify({ model: { name: `model-${i % 4}.gguf` }, prompt: `prompt number ${i} in soft light`, seed: i }),
        ),
      );
    }
  }
  // One corrupt "image" hiding in the tree: garbage bytes with a .png name.
  fileWrites.push(writeFile(path.join(outputs, "batch-0", "corrupt.png"), Buffer.from("this is not a png at all, not even close")));
  await Promise.all(fileWrites);

  const first = await scanLibrary(outputs);
  expect(first).toEqual({ added: COUNT + 1, updated: 0, removed: 0 });

  const { total, items } = searchLibrary({ limit: 500 });
  expect(total).toBe(COUNT + 1);

  // Sidecar enrichment landed and is searchable through FTS at this size.
  expect(searchLibrary({ q: "prompt number 42" }).items.map((i) => i.path)).toContain("batch-2/render_0042_.png");
  expect(searchLibrary({ model: "model-1.gguf" }).total).toBe(25);

  // The corrupt file still indexed — no dimensions, no hash, no thumbnail — and sank nothing.
  const corrupt = items.find((i) => i.path === "batch-0/corrupt.png")!;
  expect(corrupt.width).toBeNull();
  const phashOf = (rel: string) => (getDb().prepare("SELECT phash FROM library_items WHERE path = ?").get(rel) as { phash: string | null }).phash;
  expect(phashOf("batch-0/corrupt.png")).toBeNull();
  expect(existsSync(thumbPathFor("batch-0/corrupt.png"))).toBe(false);
  // A healthy neighbour got the full treatment.
  const healthy = items.find((i) => i.path === "batch-0/render_0000_.png")!;
  expect(healthy.width).toBe(32);
  expect(phashOf("batch-0/render_0000_.png")).toMatch(/^[0-9a-f]{16}$/);
  expect(existsSync(thumbPathFor("batch-0/render_0000_.png"))).toBe(true);

  // Incremental: a clean second sweep touches nothing.
  expect(await scanLibrary(outputs)).toEqual({ added: 0, updated: 0, removed: 0 });

  // Bulk change: 5 modified, 5 deleted, 5 added — only those move.
  const future = new Date(Date.now() + 60_000);
  for (let i = 0; i < 5; i++) {
    const rel = path.join(`batch-${i % 10}`, `render_${String(i).padStart(4, "0")}_.png`);
    await writeFile(path.join(outputs, rel), await noisePng(100 + i, 48, 48));
    await utimes(path.join(outputs, rel), future, future);
  }
  for (let i = 10; i < 15; i++) await unlink(path.join(outputs, `batch-${i % 10}`, `render_${String(i).padStart(4, "0")}_.png`));
  for (let i = 0; i < 5; i++) await writeFile(path.join(outputs, `batch-9`, `fresh_${i}.png`), pool[i]);
  expect(await scanLibrary(outputs)).toEqual({ added: 5, updated: 5, removed: 5 });
  expect(searchLibrary({ limit: 500 }).total).toBe(COUNT + 1);
  expect(existsSync(thumbPathFor("batch-0/render_0010_.png"))).toBe(false); // removed rows lose their thumbs

  expect(Date.now() - started).toBeLessThan(10_000);
}, 15_000);

describe("dHash duplicate grouping on indexed rows", () => {
  it("groups a re-encode/brightness pair, resists pairing structurally different images", async () => {
    const base = await stripePng(1, 0.3);
    const brighter = await sharp(base).linear(1, 12).png().toBuffer();
    const resized = await sharp(base).resize(96, 96).png().toBuffer();
    await writeFile(path.join(outputs, "orig.png"), base);
    await writeFile(path.join(outputs, "bright.png"), brighter);
    await writeFile(path.join(outputs, "resized.png"), resized);
    await writeFile(path.join(outputs, "other.png"), await stripePng(0.2, 1.4)); // different structure
    await writeFile(path.join(outputs, "noise.png"), await noisePng(7));
    await scanLibrary(outputs);

    const groups = duplicateGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.path).sort()).toEqual(["bright.png", "orig.png", "resized.png"]);
  });
});
