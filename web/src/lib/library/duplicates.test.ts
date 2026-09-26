import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db";
import { duplicateGroups } from "./search";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "sl-dup-"));
  process.env.SAFELIGHT_DATA_DIR = dataDir;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

function seedRow(p: string, phash: string | null, mtime = 1000) {
  getDb()
    .prepare("INSERT INTO library_items (path, mtime, size, phash, favorite, indexed_at) VALUES (?, ?, ?, ?, 0, ?)")
    .run(p, mtime, 100, phash, Date.now());
}

describe("duplicateGroups", () => {
  it("groups pairs within hamming ≤ 6 even when they differ in the first 16 bits", () => {
    // a↔b differ only in the first byte (0x00 vs 0x07 = 3 bits), so a naive
    // bucket on the leading 16 bits would separate them; the per-byte
    // multi-index must still pair them.
    seedRow("a.png", "0000aaaaaaaaaaaa", 2000);
    seedRow("b.png", "0700aaaaaaaaaaaa", 1000);
    seedRow("far.png", "ffffffffffffffff");
    seedRow("nohash.png", null);

    const groups = duplicateGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.path)).toEqual(["a.png", "b.png"]); // newest first
    expect(groups[0].spread).toBe(3);
  });

  it("chains transitive near-matches into one group and leaves distant hashes out", () => {
    seedRow("a.png", "0000aaaaaaaaaaaa", 3000);
    seedRow("b.png", "0700aaaaaaaaaaaa", 2000);
    seedRow("c.png", "070faaaaaaaaaaaa", 1000); // 4 bits from b, 7 from a → joins via b
    seedRow("solo.png", "123456789abcdef0");

    const groups = duplicateGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.path)).toEqual(["a.png", "b.png", "c.png"]);
    expect(groups[0].spread).toBe(7);
  });

  it("returns nothing when hashes are all far apart", () => {
    seedRow("a.png", "0000000000000000");
    seedRow("b.png", "ffffffffffffffff");
    expect(duplicateGroups()).toEqual([]);
  });
});
