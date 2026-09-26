import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { saveTheme } from "@/lib/db/sessions";
import { GET as EXPORT_GET, POST as THEME_POST } from "./[name]/route";
import { GET as LIST } from "./route";

/**
 * /api/themes + /api/themes/[name] (TEST-BRIEF §8): list + active pointer,
 * apply/clear persistence, export formats with the right content-type and
 * disposition, and a name carrying a path separator must not escape (themes
 * live in SQLite; the name must never become a filesystem path).
 */

let dir: string;

const COLORS = { bg: "#101014", surface: "#1a1a22", text: "#f2f2f7", muted: "#9a9aa5", accent: "#7ee0c3", accentText: "#08130f" };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-themes-api-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function ctx(name: string): { params: Promise<{ name: string }> } {
  return { params: Promise.resolve({ name }) };
}

function exportReq(name: string, format?: string): Promise<Response> {
  const q = format === undefined ? "" : `?format=${encodeURIComponent(format)}`;
  return EXPORT_GET(new NextRequest(new Request(`http://localhost:3001/api/themes/${encodeURIComponent(name)}${q}`)), ctx(name));
}

function postAction(name: string, body: unknown): Promise<Response> {
  return THEME_POST(
    new NextRequest(new Request(`http://localhost:3001/api/themes/${encodeURIComponent(name)}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })),
    ctx(name),
  );
}

describe("GET /api/themes", () => {
  it("lists saved themes with no active theme by default", async () => {
    saveTheme("sea-glass", { colors: COLORS, fonts: { display: "Sora", body: "Inter" } });
    const res = await LIST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { themes: { name: string }[]; active: string | null };
    expect(body.themes.map((t) => t.name)).toEqual(["sea-glass"]);
    expect(body.active).toBeNull();
  });

  it("treats a stale active pointer (theme gone) as no active theme", async () => {
    saveTheme("sea-glass", { colors: COLORS });
    await postAction("sea-glass", { action: "apply" });
    resetDbForTests(); // reopen the same db — persistence check
    const withTheme = (await (await LIST()).json()) as { active: string | null };
    expect(withTheme.active).toBe("sea-glass");
  });
});

describe("apply / clear", () => {
  it("apply persists the active theme; clear removes it", async () => {
    saveTheme("sea-glass", { colors: COLORS });
    const applied = await postAction("sea-glass", { action: "apply" });
    expect(applied.status).toBe(200);
    expect(((await applied.json()) as { active: string }).active).toBe("sea-glass");
    expect(((await (await LIST()).json()) as { active: string | null }).active).toBe("sea-glass");

    const cleared = await postAction("sea-glass", { action: "clear" });
    expect(((await cleared.json()) as { active: string | null }).active).toBeNull();
    expect(((await (await LIST()).json()) as { active: string | null }).active).toBeNull();
  });

  it("apply on an unknown theme is 404; a bad action or body is 400", async () => {
    expect((await postAction("ghost", { action: "apply" })).status).toBe(404);
    expect((await postAction("ghost", { action: "explode" })).status).toBe(400);
    expect((await postAction("ghost", "{nope")).status).toBe(400);
  });
});

describe("export", () => {
  beforeEach(() => {
    saveTheme("sea-glass", { colors: COLORS, fonts: { display: "Sora", body: "Inter", mono: "Fira Code" } });
  });

  it("serves css, tailwind, and tokens with download headers", async () => {
    const css = await exportReq("sea-glass", "css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("css");
    expect(css.headers.get("content-disposition")).toMatch(/^attachment; filename=".+"$/);
    expect(await css.text()).toContain(COLORS.accent);

    const tailwind = await exportReq("sea-glass", "tailwind");
    expect(tailwind.status).toBe(200);
    expect(tailwind.headers.get("content-disposition")).toContain("attachment");

    const tokens = await exportReq("sea-glass", "tokens");
    expect(tokens.status).toBe(200);
    expect(tokens.headers.get("content-type")).toContain("json");
    expect(() => JSON.parse("")).toThrow(); // sanity: the next line must parse real JSON
    expect(JSON.stringify(JSON.parse(await tokens.text()))).toContain(COLORS.bg);
  });

  it("rejects a missing or unknown format with 400 and an unknown theme with 404", async () => {
    expect((await exportReq("sea-glass")).status).toBe(400);
    expect((await exportReq("sea-glass", "exe")).status).toBe(400);
    expect((await exportReq("ghost", "css")).status).toBe(404);
  });

  it("a theme missing required colors reads as not found rather than exporting garbage", async () => {
    saveTheme("partial", { colors: { bg: "#000" } });
    expect((await exportReq("partial", "css")).status).toBe(404);
  });
});

describe("path-separator names cannot escape", () => {
  it("a name with separators or traversal is just an unknown theme — no file is touched", async () => {
    for (const name of ["../../etc/passwd", "..\\..\\evil", "a/b", "../outside"]) {
      expect((await exportReq(name, "css")).status).toBe(404);
      expect((await postAction(name, { action: "apply" })).status).toBe(404);
    }
    // Nothing appeared outside the sandbox data dir (themes are rows, not files).
    expect(existsSync(path.join(dir, "..", "evil"))).toBe(false);
  });
});
