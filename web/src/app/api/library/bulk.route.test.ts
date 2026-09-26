import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/library/bulk export/delete confinement (TEST-BRIEF §8, §15): sources must
 * resolve inside outputs/, export destinations inside the user's home. The index
 * and session scrub are mocked — resolveInOutputs/resolveExportDest stay real,
 * they are the controls under test. homedir() is redirected at a tmp fake home so
 * no test ever writes into the real one.
 */

const mocks = vi.hoisted(() => ({
  ensureIndex: vi.fn(async () => undefined),
  forgetPaths: vi.fn(async () => undefined),
  scrubOutputRefs: vi.fn(async () => 0),
}));

vi.mock("@/lib/library", () => ({ ensureIndex: mocks.ensureIndex, forgetPaths: mocks.forgetPaths }));
vi.mock("@/lib/db/sessions", () => ({ scrubOutputRefs: mocks.scrubOutputRefs }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => process.env.__SL_TEST_HOME ?? actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const parent = mkdtempSync(path.join(tmpdir(), "sl-bulk-"));
const OUT = path.join(parent, "outputs");
const HOME = path.join(parent, "home");
process.env.COMFY_OUTPUT_DIR = OUT;
process.env.COMFY_INPUT_DIR = path.join(parent, "inputs");
process.env.__SL_TEST_HOME = HOME;

let POST: (req: NextRequest) => Promise<Response>;

const victimDir = path.join(parent, "victims");
const victim = path.join(victimDir, "victim.png");

beforeAll(async () => {
  mkdirSync(path.join(OUT, "sub"), { recursive: true });
  mkdirSync(victimDir, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  symlinkSync(victimDir, path.join(OUT, "link"));
  symlinkSync(victim, path.join(OUT, "alias.png"));
  ({ POST } = await import("./bulk/route"));
});

afterAll(async () => {
  delete process.env.__SL_TEST_HOME;
  await rm(parent, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.ensureIndex.mockClear();
  mocks.forgetPaths.mockClear();
  mocks.scrubOutputRefs.mockClear();
  writeFileSync(victim, "victim-bytes");
  writeFileSync(path.join(parent, "escape.png"), "outside-root");
  writeFileSync(path.join(OUT, "a.png"), "a-bytes");
  writeFileSync(path.join(OUT, "a.png.json"), JSON.stringify({ prompt: "sidecar" }));
  writeFileSync(path.join(OUT, "sub", "b.png"), "b-bytes");
});

function bulk(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost:3001/api/library/bulk", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as unknown as NextRequest,
  );
}

const TRAVERSALS = ["../escape.png", "..\\escape.png", "%2e%2e/escape.png", "%252e%252e/escape.png", "escape.png\0", path.join(parent, "escape.png"), "link/victim.png", "alias.png"];

describe("request validation", () => {
  it("rejects invalid JSON, empty paths, oversized batches, and unknown actions with 400", async () => {
    expect((await bulk("nope")).status).toBe(400);
    expect((await bulk({ paths: [], action: "delete" })).status).toBe(400);
    expect((await bulk({ paths: "a.png", action: "delete" })).status).toBe(400);
    expect((await bulk({ paths: Array.from({ length: 1001 }, (_, i) => `f${i}.png`), action: "delete" })).status).toBe(400);
    expect((await bulk({ paths: ["a.png"], action: "rename" })).status).toBe(400);
    expect((await bulk({ paths: ["a.png"], action: "export" })).status).toBe(400); // no dest
  });
});

describe("delete", () => {
  it("deletes confined files with their sidecars and scrubs the index and sessions", async () => {
    const res = await bulk({ paths: ["a.png", "sub/b.png"], action: "delete" });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ ok: true, deleted: 2, skipped: [] });
    expect(existsSync(path.join(OUT, "a.png"))).toBe(false);
    expect(existsSync(path.join(OUT, "a.png.json"))).toBe(false);
    expect(existsSync(path.join(OUT, "sub", "b.png"))).toBe(false);
    expect(mocks.forgetPaths).toHaveBeenCalledWith(["a.png", "sub/b.png"]);
    expect(mocks.scrubOutputRefs).toHaveBeenCalledWith(["a.png", "sub/b.png"]);
  });

  it("skips every traversal payload and deletes nothing outside outputs", async () => {
    const res = await bulk({ paths: TRAVERSALS, action: "delete" });
    const body = (await res.json()) as { deleted: number; skipped: string[] };
    expect(body.deleted).toBe(0);
    expect(body.skipped).toEqual(TRAVERSALS);
    expect(existsSync(path.join(parent, "escape.png"))).toBe(true);
    expect(existsSync(victim)).toBe(true);
    expect(mocks.scrubOutputRefs).toHaveBeenCalledWith([]);
  });

  it("mixes confined deletes with skipped escapes without letting one mask the other", async () => {
    const res = await bulk({ paths: ["../escape.png", "a.png"], action: "delete" });
    expect((await res.json()) as object).toMatchObject({ deleted: 1, skipped: ["../escape.png"] });
    expect(existsSync(path.join(parent, "escape.png"))).toBe(true);
    expect(existsSync(path.join(OUT, "a.png"))).toBe(false);
  });
});

describe("export", () => {
  it("copies files and sidecars into a folder under home, renaming on collision", async () => {
    const dest = path.join(HOME, "exports");
    const first = await bulk({ paths: ["a.png"], action: "export", dest });
    expect((await first.json()) as object).toMatchObject({ ok: true, exported: 1, skipped: [] });
    expect(await readFile(path.join(dest, "a.png"), "utf8")).toBe("a-bytes");
    expect(await readFile(path.join(dest, "a.png.json"), "utf8")).toContain("sidecar");

    const second = await bulk({ paths: ["a.png"], action: "export", dest });
    expect(((await second.json()) as { exported: number }).exported).toBe(1);
    expect(existsSync(path.join(dest, "a-1.png"))).toBe(true);
  });

  it("refuses a dest outside home with 403 and copies nothing", async () => {
    for (const dest of [path.join(parent, "elsewhere"), "/definitely-not-home/exports", "relative/exports", `${HOME}/ok\0`]) {
      const res = await bulk({ paths: ["a.png"], action: "export", dest });
      expect(res.status).toBe(403);
    }
    expect(existsSync(path.join(parent, "elsewhere"))).toBe(false);
  });

  it("refuses a dest that reaches outside home through a symlinked segment", async () => {
    symlinkSync(path.join(parent, "victims"), path.join(HOME, "sneaky"));
    const res = await bulk({ paths: ["a.png"], action: "export", dest: path.join(HOME, "sneaky", "drop") });
    expect(res.status).toBe(403);
    expect(existsSync(path.join(victimDir, "drop", "a.png"))).toBe(false);
  });

  it("skips traversal sources on export and copies only confined ones", async () => {
    const dest = path.join(HOME, "mixed");
    const res = await bulk({ paths: [...TRAVERSALS, "sub/b.png"], action: "export", dest });
    const body = (await res.json()) as { exported: number; skipped: string[] };
    expect(body.exported).toBe(1);
    expect(body.skipped).toEqual(TRAVERSALS);
    expect(existsSync(path.join(dest, "b.png"))).toBe(true);
    expect(existsSync(path.join(dest, "victim.png"))).toBe(false);
    expect(existsSync(path.join(dest, "escape.png"))).toBe(false);
  });
});
