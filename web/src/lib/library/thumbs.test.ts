import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noisePng, stripePng } from "./test-images";
import { deleteThumb, ensureThumb, THUMB_WIDTH, thumbPathFor } from "./thumbs";

/** Thumbnail generation, caching, invalidation and the corrupt-source path (TEST-BRIEF §10). */

let dataDir: string;
let sources: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "sl-thumb-data-"));
  sources = await mkdtemp(path.join(tmpdir(), "sl-thumb-src-"));
  process.env.SAFELIGHT_DATA_DIR = dataDir;
});

afterEach(async () => {
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
  await rm(sources, { recursive: true, force: true });
});

describe("thumbPathFor", () => {
  it("hashes the library path into data/thumbs/<sha1>.webp, stable and collision-averse", () => {
    const a = thumbPathFor("safelight/a.png");
    expect(a).toBe(thumbPathFor("safelight/a.png"));
    expect(a).toMatch(new RegExp(`^${dataDir}/thumbs/[0-9a-f]{40}\\.webp$`));
    expect(a).not.toBe(thumbPathFor("safelight/b.png"));
  });
});

describe("ensureThumb", () => {
  it("writes a webp preview capped at 384px without enlarging small sources", async () => {
    const small = path.join(sources, "small.png");
    await writeFile(small, await noisePng(1, 32, 32));
    const target = await ensureThumb(small, "small.png");
    expect(target).toBe(thumbPathFor("small.png"));
    const meta = await sharp(target!).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(32); // withoutEnlargement

    const big = path.join(sources, "big.png");
    await writeFile(big, await stripePng(1, 0.3, 900, 600));
    const bigThumb = await ensureThumb(big, "big.png");
    expect((await sharp(bigThumb!).metadata()).width).toBe(THUMB_WIDTH);
  });

  it("caches: a second call leaves the existing thumb untouched, force regenerates it", async () => {
    const src = path.join(sources, "img.png");
    await writeFile(src, await noisePng(2));
    const thumb = (await ensureThumb(src, "img.png"))!;
    const old = new Date(Date.now() - 60_000);
    await utimes(thumb, old, old);
    const before = (await stat(thumb)).mtimeMs;

    await ensureThumb(src, "img.png"); // cached — no rewrite
    expect((await stat(thumb)).mtimeMs).toBe(before);

    await ensureThumb(src, "img.png", true); // invalidated — rewritten
    expect((await stat(thumb)).mtimeMs).toBeGreaterThan(before);
  });

  it("answers null for a corrupt source and writes nothing", async () => {
    const bad = path.join(sources, "bad.png");
    await writeFile(bad, "png? no. bytes of nonsense.");
    expect(await ensureThumb(bad, "bad.png")).toBeNull();
    expect(existsSync(thumbPathFor("bad.png"))).toBe(false);
    expect(await ensureThumb(path.join(sources, "missing.png"), "missing.png")).toBeNull();
  });
});

describe("deleteThumb", () => {
  it("removes the thumb and tolerates one that never existed", async () => {
    const src = path.join(sources, "gone.png");
    await writeFile(src, await noisePng(3));
    await ensureThumb(src, "gone.png");
    expect(existsSync(thumbPathFor("gone.png"))).toBe(true);
    await deleteThumb("gone.png");
    expect(existsSync(thumbPathFor("gone.png"))).toBe(false);
    await expect(deleteThumb("never-existed.png")).resolves.toBeUndefined();
  });
});
