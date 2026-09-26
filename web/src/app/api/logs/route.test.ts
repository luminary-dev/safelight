import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { getLogger } from "@/lib/log";
import { GET } from "./route";

/**
 * /api/logs: the Settings log viewer tail, and the redaction promise — a key
 * that goes through the real write path (getLogger) must come out of the API
 * as a length+hash marker, never as key material (TEST-BRIEF §8).
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-logs-api-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function get(query = ""): Promise<Response> {
  return GET(new NextRequest(new Request(`http://localhost:3001/api/logs${query}`)));
}

describe("GET /api/logs", () => {
  it("returns an empty tail when no log file exists yet", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lines: [], size: 0 });
  });

  it("tails the structured log written through getLogger", async () => {
    getLogger().info({ area: "test" }, "first line");
    getLogger().info({ area: "test" }, "second line");
    const body = (await (await get()).json()) as { lines: string[]; size: number };
    expect(body.size).toBeGreaterThan(0);
    expect(body.lines.length).toBeGreaterThanOrEqual(2);
    expect(body.lines.at(-1)).toContain("second line");
  });

  it("honors ?lines= and clamps garbage to a sane default", async () => {
    for (let i = 0; i < 5; i++) getLogger().info(`entry ${i}`);
    const two = (await (await get("?lines=2")).json()) as { lines: string[] };
    expect(two.lines).toHaveLength(2);
    expect(two.lines[1]).toContain("entry 4");
    const garbage = await get("?lines=banana");
    expect(garbage.status).toBe(200);
  });

  it("never serves key material that went through the logger — the write path redacts it", async () => {
    const secret = "sk-live-abcdef1234567890";
    getLogger().warn({ apiKey: secret, note: `header was Bearer ${secret}` }, "provider call failed");
    const res = await get();
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(secret);
    expect(text).not.toContain("abcdef1234567890");
    expect(text).toContain("[redacted");
  });

  it("documents the boundary: a line injected into the file BYPASSING the logger is served as-is", async () => {
    // Nothing in the product writes this file except lib/log (which scrubs at
    // write time); this pins that the API itself adds no second scrub pass.
    mkdirSync(path.join(dir, "logs"), { recursive: true });
    appendFileSync(path.join(dir, "logs", "safelight.log"), `{"msg":"raw injected sk-raw-9999"}\n`);
    const body = (await (await get()).json()) as { lines: string[] };
    expect(body.lines.some((l) => l.includes("sk-raw-9999"))).toBe(true);
  });
});
