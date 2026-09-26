import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { GET, PATCH } from "./route";

/**
 * /api/settings: the allowlisted key-value surface (TEST-BRIEF §8). Every test
 * runs against a throwaway SQLite database in a tmpdir — never the user's data/.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-settings-api-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function patch(body: unknown): Promise<Response> {
  return PATCH(
    new Request("http://localhost:3001/api/settings", {
      method: "PATCH",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as unknown as NextRequest,
  );
}

describe("GET", () => {
  it("returns an empty settings object on a fresh install", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ settings: {} });
  });
});

describe("PATCH", () => {
  it("round-trips allowlisted values through GET", async () => {
    const res = await patch({ spendLimitDayHard: 12.5, telemetryEnabled: true, localOnly: false });
    expect(res.status).toBe(200);
    const { settings } = (await res.json()) as { settings: Record<string, unknown> };
    expect(settings).toMatchObject({ spendLimitDayHard: 12.5, telemetryEnabled: true, localOnly: false });
    const again = (await (await GET()).json()) as { settings: Record<string, unknown> };
    expect(again.settings.spendLimitDayHard).toBe(12.5);
  });

  it("rejects an unknown key with 400, never 500", async () => {
    const res = await patch({ evilKey: 1 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Unknown setting/);
  });

  it("rejects a type mismatch with 400", async () => {
    expect((await patch({ spendLimitDayHard: "lots" })).status).toBe(400);
    expect((await patch({ telemetryEnabled: "yes" })).status).toBe(400);
  });

  it("rejects a negative or non-finite number with 400", async () => {
    expect((await patch({ spendLimitMonthHard: -3 })).status).toBe(400);
  });

  it("null clears a key back to its default", async () => {
    await patch({ spendLimitDaySoft: 4 });
    const res = await patch({ spendLimitDaySoft: null });
    expect(res.status).toBe(200);
    const { settings } = (await res.json()) as { settings: Record<string, unknown> };
    expect("spendLimitDaySoft" in settings).toBe(false);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await patch("{not json");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Invalid JSON/);
  });

  it("structured stores (mcp_servers, activeTheme) are not writable here", async () => {
    expect((await patch({ mcp_servers: [] })).status).toBe(400);
    expect((await patch({ activeTheme: "x" })).status).toBe(400);
  });
});
