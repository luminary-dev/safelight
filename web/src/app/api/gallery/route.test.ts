import { existsSync, mkdtempSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * /api/gallery walks OUTPUT_DIR and DELETE removes exactly one image inside it
 * (TEST-BRIEF §8, §15 — the traversal payload list). OUTPUT_DIR is a per-suite
 * tmpdir wired through COMFY_OUTPUT_DIR before the route module loads.
 */

const parent = mkdtempSync(path.join(tmpdir(), "sl-gallery-"));
const OUT = path.join(parent, "outputs");
process.env.COMFY_OUTPUT_DIR = OUT;
process.env.COMFY_INPUT_DIR = path.join(parent, "inputs");

let GET: () => Promise<Response>;
let DELETE: (req: NextRequest) => Promise<Response>;

const victimDir = path.join(parent, "victims");
const victim = path.join(victimDir, "victim.png");

beforeAll(async () => {
  mkdirSync(path.join(OUT, "sub"), { recursive: true });
  mkdirSync(victimDir, { recursive: true });
  ({ GET, DELETE } = await import("./route"));
});

afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

beforeEach(() => {
  // Re-plant the escape targets each test so one deletion cannot mask another.
  writeFileSync(victim, "victim-bytes");
  writeFileSync(path.join(parent, "escape.png"), "outside-root");
});

function del(body: unknown): Promise<Response> {
  return DELETE(
    new Request("http://localhost:3001/api/gallery", {
      method: "DELETE",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as unknown as NextRequest,
  );
}

describe("GET", () => {
  it("lists nested images newest-first and ignores non-images", async () => {
    const old = path.join(OUT, "old.png");
    const fresh = path.join(OUT, "sub", "fresh.jpg");
    writeFileSync(old, "1");
    writeFileSync(fresh, "2");
    writeFileSync(path.join(OUT, "notes.txt"), "not an image");
    utimesSync(old, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    utimesSync(fresh, new Date(1_800_000_000_000), new Date(1_800_000_000_000));

    const body = (await (await GET()).json()) as { items: { filename: string; subfolder: string }[]; dir: string };
    expect(body.dir).toBe(OUT);
    expect(body.items.map((i) => i.filename)).toEqual(["fresh.jpg", "old.png"]);
    expect(body.items[0].subfolder).toBe("sub");

    await rm(old);
    await rm(fresh);
    await rm(path.join(OUT, "notes.txt"));
  });
});

describe("DELETE contract", () => {
  it("deletes exactly the referenced image inside a subfolder", async () => {
    const target = path.join(OUT, "sub", "todelete.png");
    writeFileSync(target, "x");
    const res = await del({ filename: "todelete.png", subfolder: "sub" });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ ok: true });
    expect(existsSync(target)).toBe(false);
  });

  it("answers 404 for a file that is already gone", async () => {
    const res = await del({ filename: "never-existed.png", subfolder: "" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/already gone/i);
  });

  it("rejects invalid JSON with 400", async () => {
    expect((await del("this is not json")).status).toBe(400);
  });

  it("rejects a non-image filename with 400", async () => {
    writeFileSync(path.join(OUT, "keys.txt"), "not deletable here");
    expect((await del({ filename: "keys.txt" })).status).toBe(400);
    expect(existsSync(path.join(OUT, "keys.txt"))).toBe(true);
    await rm(path.join(OUT, "keys.txt"));
  });
});

describe("DELETE confinement (§15 payload list)", () => {
  it.each([
    ["dot-dot filename", { filename: "../escape.png", subfolder: "" }],
    ["backslash dot-dot filename", { filename: "..\\escape.png", subfolder: "" }],
    ["slash in filename", { filename: "sub/../../escape.png", subfolder: "" }],
    ["dot-dot subfolder", { filename: "escape.png", subfolder: ".." }],
    ["nested dot-dot subfolder", { filename: "escape.png", subfolder: "sub/../.." }],
    ["backslash dot-dot subfolder", { filename: "escape.png", subfolder: "..\\" }],
    ["absolute subfolder", { filename: "escape.png", subfolder: parent }],
    ["missing filename", { subfolder: "sub" }],
  ])("refuses %s with 400 and deletes nothing", async (_name, body) => {
    expect((await del(body)).status).toBe(400);
    expect(existsSync(path.join(parent, "escape.png"))).toBe(true);
  });

  it("treats a URL-encoded traversal as a literal (missing) name — 404, nothing outside touched", async () => {
    expect((await del({ filename: "escape.png", subfolder: "%2e%2e" })).status).toBe(404);
    expect((await del({ filename: "escape.png", subfolder: "%252e%252e" })).status).toBe(404);
    expect(existsSync(path.join(parent, "escape.png"))).toBe(true);
  });

  it("rejects a null byte in the reference with 400, not a 500", async () => {
    expect((await del({ filename: "a\0.png", subfolder: "" })).status).toBe(400);
    expect((await del({ filename: "a.png", subfolder: "sub\0" })).status).toBe(400);
  });

  it("cannot delete through a symlinked directory planted inside outputs", async () => {
    symlinkSync(victimDir, path.join(OUT, "sub", "link"));
    try {
      const res = await del({ filename: "victim.png", subfolder: "sub/link" });
      expect(res.status).toBe(400);
      expect(existsSync(victim)).toBe(true);
    } finally {
      await rm(path.join(OUT, "sub", "link"), { force: true });
    }
  });

  it("refuses a symlinked file inside outputs whose target lives outside", async () => {
    symlinkSync(victim, path.join(OUT, "alias.png"));
    try {
      const res = await del({ filename: "alias.png", subfolder: "" });
      expect(res.status).toBe(400);
      expect(existsSync(victim)).toBe(true);
    } finally {
      await rm(path.join(OUT, "alias.png"), { force: true });
    }
  });
});
