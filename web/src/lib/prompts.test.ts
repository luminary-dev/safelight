import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "./db";
import { deletePrompt, expandPromptText, expandWildcards, getPrompt, getPromptByTitle, hasWildcards, listPrompts, seededRng, upsertPrompt } from "./prompts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-prompts-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("seededRng", () => {
  it("is deterministic and stays in [0, 1)", () => {
    const a = seededRng(123456789);
    const b = seededRng(123456789);
    for (let i = 0; i < 50; i += 1) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("folds seeds above 32 bits instead of collapsing them", () => {
    const big = Number.MAX_SAFE_INTEGER - 12345;
    expect(seededRng(big)()).not.toBe(seededRng(big % 0x100000000)());
  });
});

describe("expandWildcards", () => {
  it("reproduces the exact expansion for a fixed seed", () => {
    const text = "a {red|green|blue} bird on a {mossy|snowy} {rock|branch}";
    const once = expandWildcards(text, 42);
    expect(expandWildcards(text, 42)).toBe(once);
    expect(once).not.toMatch(/[{}|]/);
  });

  it("picks each option somewhere across seeds (roughly uniform)", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 120; seed += 1) seen.add(expandWildcards("{a|b|c}", seed));
    expect([...seen].sort()).toEqual(["a", "b", "c"]);
  });

  it("varies across different seeds", () => {
    const outputs = new Set(Array.from({ length: 30 }, (_, seed) => expandWildcards("{one|two|three|four}", seed)));
    expect(outputs.size).toBeGreaterThan(1);
  });

  it("handles nested groups", () => {
    for (let seed = 0; seed < 40; seed += 1) {
      expect(["a", "b", "c"]).toContain(expandWildcards("{a|{b|c}}", seed));
    }
  });

  it("leaves unbalanced braces literal", () => {
    expect(expandWildcards("{a|b", 1)).toBe("{a|b");
    expect(expandWildcards("plain text", 1)).toBe("plain text");
  });

  it("resolves __title__ references through the resolver", () => {
    const out = expandWildcards("x __Sunset__ y", 1, (t) => (t === "Sunset" ? "golden hour" : null));
    expect(out).toBe("x golden hour y");
  });

  it("expands wildcards inside an inserted prompt", () => {
    const out = expandWildcards("__colors__", 7, (t) => (t === "colors" ? "{red|blue}" : null));
    expect(["red", "blue"]).toContain(out);
  });

  it("stops at one level deep: references inside an inserted prompt stay literal", () => {
    const resolve = (t: string) => (t === "a" ? "uses __b__" : t === "b" ? "SHOULD NOT APPEAR" : null);
    expect(expandWildcards("__a__", 1, resolve)).toBe("uses __b__");
  });

  it("is cycle-safe for mutually and self-referential prompts", () => {
    const resolve = (t: string) => (t === "a" ? "A(__b__)" : t === "b" ? "B(__a__)" : null);
    expect(expandWildcards("__a__", 1, resolve)).toBe("A(__b__)");
    expect(expandWildcards("__loop__", 1, (t) => (t === "loop" ? "again __loop__" : null))).toBe("again __loop__");
  });

  it("leaves unknown titles literal", () => {
    expect(expandWildcards("keep __missing__ here", 1)).toBe("keep __missing__ here");
  });
});

describe("hasWildcards", () => {
  it("detects braces and references", () => {
    expect(hasWildcards("a {b|c}")).toBe(true);
    expect(hasWildcards("a __ref__")).toBe(true);
    expect(hasWildcards("just __ trailing underscores")).toBe(false);
    expect(hasWildcards("plain")).toBe(false);
  });
});

describe("prompts CRUD", () => {
  it("round-trips a saved prompt", () => {
    const saved = upsertPrompt({ title: "Golden hour", text: "warm light, long shadows", negative: "night", tags: ["light", "mood"] });
    expect(saved.id).toBeTruthy();
    const back = getPrompt(saved.id);
    expect(back).toMatchObject({ title: "Golden hour", text: "warm light, long shadows", negative: "night", tags: ["light", "mood"] });
  });

  it("updates in place when the id already exists", () => {
    const saved = upsertPrompt({ title: "One", text: "first" });
    upsertPrompt({ id: saved.id, title: "One v2", text: "second" });
    expect(listPrompts()).toHaveLength(1);
    expect(getPrompt(saved.id)?.text).toBe("second");
  });

  it("rejects empty titles and text", () => {
    expect(() => upsertPrompt({ title: " ", text: "x" })).toThrow(/title/i);
    expect(() => upsertPrompt({ title: "x", text: "" })).toThrow(/text/i);
  });

  it("searches by title and by tag, case-insensitively", () => {
    upsertPrompt({ title: "Moody portrait", text: "a", tags: ["portrait"] });
    upsertPrompt({ title: "Landscape", text: "b", tags: ["nature", "wide"] });
    expect(listPrompts("moody").map((p) => p.title)).toEqual(["Moody portrait"]);
    expect(listPrompts("NATURE").map((p) => p.title)).toEqual(["Landscape"]);
    expect(listPrompts("nothing")).toHaveLength(0);
    expect(listPrompts()).toHaveLength(2);
  });

  it("looks up by title case-insensitively for __title__ wildcards", () => {
    upsertPrompt({ title: "Style Kit", text: "oil painting, impasto" });
    expect(getPromptByTitle("style kit")?.text).toBe("oil painting, impasto");
    expect(getPromptByTitle("unknown")).toBeUndefined();
  });

  it("deletes and reports whether a row existed", () => {
    const saved = upsertPrompt({ title: "t", text: "x" });
    expect(deletePrompt(saved.id)).toBe(true);
    expect(deletePrompt(saved.id)).toBe(false);
  });
});

describe("expandPromptText", () => {
  it("expands __title__ from the library and stays deterministic per seed", () => {
    upsertPrompt({ title: "Style", text: "oil painting" });
    expect(expandPromptText("a cat, __style__", 5)).toBe("a cat, oil painting");
    const t = "a {cat|dog}, __style__";
    expect(expandPromptText(t, 9)).toBe(expandPromptText(t, 9));
  });
});
