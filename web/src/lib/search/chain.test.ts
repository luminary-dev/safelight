import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db";
import { queryHash, searchWeb } from "./chain";
import type { SearchProvider, SearchResult } from "./types";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-search-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function result(n: number): SearchResult {
  return { title: `t${n}`, url: `https://example.com/${n}`, snippet: `s${n}` };
}

/** Fake provider that counts calls; never touches the network. */
function fake(id: string, opts?: { available?: boolean; fail?: boolean; results?: SearchResult[] }): SearchProvider & { calls: number } {
  const p = {
    id,
    calls: 0,
    available: () => opts?.available ?? true,
    async search() {
      p.calls++;
      if (opts?.fail) throw new Error(`${id} down`);
      return opts?.results ?? [result(1)];
    },
  };
  return p;
}

describe("searchWeb failover", () => {
  it("uses the first available provider", async () => {
    const a = fake("a");
    const b = fake("b");
    const out = await searchWeb("hello", { providers: [a, b] });
    expect(out.provider).toBe("a");
    expect(out.cached).toBe(false);
    expect(b.calls).toBe(0);
  });

  it("skips providers whose key is missing without calling them", async () => {
    const a = fake("a", { available: false });
    const b = fake("b");
    const out = await searchWeb("hello", { providers: [a, b] });
    expect(out.provider).toBe("b");
    expect(a.calls).toBe(0);
  });

  it("fails over when a provider errors", async () => {
    const a = fake("a", { fail: true });
    const b = fake("b");
    const out = await searchWeb("hello", { providers: [a, b] });
    expect(out.provider).toBe("b");
    expect(a.calls).toBe(1);
  });

  it("throws when every provider fails, keeping the last error", async () => {
    const a = fake("a", { fail: true });
    const b = fake("b", { fail: true });
    await expect(searchWeb("hello", { providers: [a, b] })).rejects.toThrow(/b down/);
  });

  it("throws when no provider is available", async () => {
    await expect(searchWeb("hello", { providers: [fake("a", { available: false })] })).rejects.toThrow(/No search provider/);
  });

  it("rejects an empty query", async () => {
    await expect(searchWeb("   ", { providers: [fake("a")] })).rejects.toThrow(/Empty query/);
  });

  it("caps results at 8", async () => {
    const many = Array.from({ length: 12 }, (_, i) => result(i));
    const out = await searchWeb("hello", { providers: [fake("a", { results: many })] });
    expect(out.results).toHaveLength(8);
  });
});

describe("searchWeb cache", () => {
  it("misses then hits: second identical query never reaches a provider", async () => {
    const a = fake("a", { results: [result(1), result(2)] });
    const first = await searchWeb("Design Systems", { providers: [a] });
    expect(first.cached).toBe(false);
    const second = await searchWeb("Design Systems", { providers: [a] });
    expect(second.cached).toBe(true);
    expect(second.provider).toBe("a");
    expect(second.results).toEqual(first.results);
    expect(a.calls).toBe(1);
  });

  it("normalises the query: case and surrounding whitespace share one entry", async () => {
    const a = fake("a");
    await searchWeb("  Hello World ", { providers: [a] });
    const out = await searchWeb("hello world", { providers: [fake("b")] });
    expect(out.cached).toBe(true);
    expect(a.calls).toBe(1);
    expect(queryHash("  Hello World ")).toBe(queryHash("hello world"));
  });

  it("expires after the 1-hour TTL and re-queries", async () => {
    const a = fake("a");
    await searchWeb("hello", { providers: [a] });
    // Age the row past the TTL instead of faking clocks.
    getDb()
      .prepare("UPDATE search_cache SET created_at = ? WHERE query_hash = ?")
      .run(Date.now() - 61 * 60 * 1000, queryHash("hello"));
    const out = await searchWeb("hello", { providers: [a] });
    expect(out.cached).toBe(false);
    expect(a.calls).toBe(2);
  });

  it("a stale entry is replaced, not duplicated", async () => {
    await searchWeb("hello", { providers: [fake("a")] });
    getDb()
      .prepare("UPDATE search_cache SET created_at = ? WHERE query_hash = ?")
      .run(Date.now() - 61 * 60 * 1000, queryHash("hello"));
    await searchWeb("hello", { providers: [fake("b")] });
    const rows = getDb().prepare("SELECT provider FROM search_cache WHERE query_hash = ?").all(queryHash("hello")) as { provider: string }[];
    expect(rows).toEqual([{ provider: "b" }]);
  });
});
