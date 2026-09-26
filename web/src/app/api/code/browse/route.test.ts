import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { GET } from "./route";

/**
 * /api/code/browse (TEST-BRIEF §8): confined to a fake HOME in a tmpdir (plus
 * SAFELIGHT_BROWSE_ROOTS), rate-limited via the sandboxed token bucket, `~`
 * from user input not honoured, and a symlink out of home not followed.
 */

let sandbox: string;
let home: string;
let outside: string;
let extraRoot: string;
const prevEnv = new Map<string, string | undefined>();

beforeEach(async () => {
  // realpath up front: macOS tmpdirs live behind the /var → /private/var symlink.
  sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), "sl-browse-api-")));
  home = path.join(sandbox, "home");
  outside = path.join(sandbox, "outside");
  extraRoot = path.join(sandbox, "extra");
  for (const d of [
    path.join(home, "Projects"),
    path.join(home, "Documents"),
    path.join(home, ".hidden"),
    path.join(home, "node_modules"),
    path.join(outside, "loot"),
    path.join(extraRoot, "repo"),
  ]) {
    mkdirSync(d, { recursive: true });
  }
  symlinkSync(outside, path.join(home, "escape-hatch"));

  for (const key of ["HOME", "SAFELIGHT_BROWSE_ROOTS", "SAFELIGHT_DATA_DIR"]) prevEnv.set(key, process.env[key]);
  process.env.HOME = home;
  process.env.SAFELIGHT_BROWSE_ROOTS = extraRoot;
  process.env.SAFELIGHT_DATA_DIR = path.join(sandbox, "data");
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  for (const [key, value] of prevEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(sandbox, { recursive: true, force: true });
});

function browse(p?: string): Promise<Response> {
  const q = p === undefined ? "" : `?path=${encodeURIComponent(p)}`;
  return GET(new NextRequest(new Request(`http://localhost:3001/api/code/browse${q}`)));
}

interface BrowseBody {
  path: string;
  parent: string | null;
  home: string;
  dirs: { name: string; path: string }[];
}

describe("GET /api/code/browse", () => {
  it("defaults to home, hiding dotfolders and node_modules, and never lists the symlink out", async () => {
    const res = await browse();
    expect(res.status).toBe(200);
    const body = (await res.json()) as BrowseBody;
    expect(body.path).toBe(home);
    expect(body.dirs.map((d) => d.name)).toEqual(["Documents", "Projects"]);
  });

  it("navigates into a subfolder and exposes the parent link only inside the roots", async () => {
    const body = (await (await browse(path.join(home, "Projects"))).json()) as BrowseBody;
    expect(body.path).toBe(path.join(home, "Projects"));
    expect(body.parent).toBe(home);
    const atHome = (await (await browse(home)).json()) as BrowseBody;
    expect(atHome.parent).toBeNull(); // home's parent is outside the roots
  });

  it("coerces a path outside every root back to home", async () => {
    const body = (await (await browse(outside)).json()) as BrowseBody;
    expect(body.path).toBe(home);
  });

  it("allows a SAFELIGHT_BROWSE_ROOTS entry beyond home", async () => {
    const body = (await (await browse(extraRoot)).json()) as BrowseBody;
    expect(body.path).toBe(extraRoot);
    expect(body.dirs.map((d) => d.name)).toEqual(["repo"]);
  });

  it("does not honour ~ from user input", async () => {
    const body = (await (await browse("~/Projects")).json()) as BrowseBody;
    expect(body.path).toBe(home); // relative-looking input falls back to home
  });

  it("does not follow a symlink out of home — regression: it used to list the target", async () => {
    const res = await browse(path.join(home, "escape-hatch"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as BrowseBody;
    expect(body.path).toBe(home); // coerced back rather than resolved outside
    expect(body.dirs.map((d) => d.name)).not.toContain("loot");
  });

  it("answers 400 for a folder that cannot be opened", async () => {
    const res = await browse(path.join(home, "Projects", "nope-not-here"));
    expect(res.status).toBe(400);
  });

  it("rate-limits a burst of listings with 429", async () => {
    let limited = 0;
    for (let i = 0; i < 45; i++) {
      const res = await browse();
      if (res.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    const last = await browse();
    expect(last.status).toBe(429);
    expect(((await last.json()) as { error: string }).error).toMatch(/Slow down/);
  });
});
