import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * /api/library/thumb serves the 384px webp for one library path; everything outside
 * outputs/ is a 403 through resolveInOutputs (TEST-BRIEF §8, §15 payload list).
 * OUTPUT_DIR and the data dir (thumb cache) are per-suite tmpdirs.
 */

const parent = mkdtempSync(path.join(tmpdir(), "sl-thumb-"));
const OUT = path.join(parent, "outputs");
process.env.COMFY_OUTPUT_DIR = OUT;
process.env.COMFY_INPUT_DIR = path.join(parent, "inputs");

let GET: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  process.env.SAFELIGHT_DATA_DIR = path.join(parent, "data");
  mkdirSync(path.join(OUT, "sub"), { recursive: true });
  const sharp = (await import("sharp")).default;
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .png()
    .toBuffer();
  writeFileSync(path.join(OUT, "art.png"), png);
  writeFileSync(path.join(OUT, "sub", "deep.png"), png);
  writeFileSync(path.join(OUT, "broken.png"), "not really an image");
  // Escape targets.
  writeFileSync(path.join(parent, "secret.png"), "OUTSIDE-SECRET");
  symlinkSync(parent, path.join(OUT, "link"));
  symlinkSync(path.join(parent, "secret.png"), path.join(OUT, "alias.png"));
  ({ GET } = await import("./thumb/route"));
});

afterAll(async () => {
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(parent, { recursive: true, force: true });
});

function thumb(relPath: string | null, headers?: Record<string, string>, rawQuery?: string): Promise<Response> {
  const query = rawQuery ?? (relPath === null ? "" : `path=${encodeURIComponent(relPath)}`);
  return GET(new NextRequest(new Request(`http://localhost:3001/api/library/thumb?${query}`, { headers })));
}

describe("serving thumbnails", () => {
  it("generates and serves a webp thumbnail with revalidation headers", async () => {
    const res = await thumb("art.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toContain("must-revalidate");
    expect(res.headers.get("etag")).toMatch(/^".+"$/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF"); // webp container
    // The cache lands under the tmp data dir, never beside the user's real data.
    expect(existsSync(path.join(parent, "data", "thumbs"))).toBe(true);
  });

  it("serves a nested path", async () => {
    expect((await thumb("sub/deep.png")).status).toBe(200);
  });

  it("answers 304 on a matching If-None-Match", async () => {
    const etag = (await thumb("art.png")).headers.get("etag")!;
    const res = await thumb("art.png", { "if-none-match": etag });
    expect(res.status).toBe(304);
  });

  it("answers 404 when the image cannot be thumbnailed", async () => {
    expect((await thumb("broken.png")).status).toBe(404);
  });
});

describe("confinement (§15 payload list)", () => {
  it.each([
    ["empty path", ""],
    ["dot-dot", "../secret.png"],
    ["nested dot-dot", "sub/../../secret.png"],
    ["bare dot-dot", ".."],
    ["absolute path", path.join(parent, "secret.png")],
    ["null byte", "art.png\0.txt"],
    ["backslash dot-dot (missing literal on posix)", "..\\secret.png"],
    ["double-encoded traversal (missing literal)", "%2e%2e/secret.png"],
    ["missing file", "nope.png"],
    ["symlinked directory escape", "link/secret.png"],
    ["symlinked file escape", "alias.png"],
  ])("refuses %s with 403 and leaks nothing", async (_name, rel) => {
    const res = await thumb(rel);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("OUTSIDE-SECRET");
  });

  it("decodes %2e%2e in the query back to a traversal and refuses it", async () => {
    const res = await thumb(null, undefined, "path=%2e%2e%2fsecret.png");
    expect(res.status).toBe(403);
  });

  it("refuses a missing path parameter", async () => {
    expect((await thumb(null)).status).toBe(403);
  });
});
