import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { takeToken } from "./rate-limit";

/**
 * rate-limit.ts is a SQLite token bucket (TEST-BRIEF §6, §15): refill is continuous
 * at ratePerMinute up to burst, and state lives in the DB so a process restart never
 * grants a fresh burst. Date.now is under fake timers.
 */

const T0 = new Date("2026-09-26T12:00:00Z").getTime();
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-ratelimit-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(async () => {
  vi.useRealTimers();
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("takeToken", () => {
  it("passes every call under the burst limit", () => {
    for (let i = 0; i < 3; i++) expect(takeToken("gen", 60, 3)).toBe(true);
  });

  it("refuses the first call past the burst", () => {
    for (let i = 0; i < 3; i++) takeToken("gen", 60, 3);
    expect(takeToken("gen", 60, 3)).toBe(false);
    expect(takeToken("gen", 60, 3)).toBe(false);
  });

  it("refills one token after one window step and no more", () => {
    for (let i = 0; i < 3; i++) takeToken("gen", 60, 3);
    expect(takeToken("gen", 60, 3)).toBe(false);
    // 60/min = 1 token per second.
    vi.setSystemTime(T0 + 1_000);
    expect(takeToken("gen", 60, 3)).toBe(true);
    expect(takeToken("gen", 60, 3)).toBe(false);
  });

  it("does not lose the accumulated fraction when a refused probe writes state back", () => {
    for (let i = 0; i < 3; i++) takeToken("gen", 60, 3);
    vi.setSystemTime(T0 + 500);
    expect(takeToken("gen", 60, 3)).toBe(false); // 0.5 tokens — refused, but the 0.5 must survive
    vi.setSystemTime(T0 + 1_000);
    expect(takeToken("gen", 60, 3)).toBe(true);
  });

  it("caps the refill at burst — a long idle never banks extra tokens", () => {
    for (let i = 0; i < 3; i++) takeToken("gen", 60, 3);
    vi.setSystemTime(T0 + 10 * 60_000);
    for (let i = 0; i < 3; i++) expect(takeToken("gen", 60, 3)).toBe(true);
    expect(takeToken("gen", 60, 3)).toBe(false);
  });

  it("keeps separate buckets per key", () => {
    for (let i = 0; i < 3; i++) takeToken("generate", 60, 3);
    expect(takeToken("generate", 60, 3)).toBe(false);
    expect(takeToken("search", 60, 3)).toBe(true);
  });

  it("survives a restart — reopening the same DB file grants no fresh burst", () => {
    for (let i = 0; i < 3; i++) takeToken("gen", 60, 3);
    expect(takeToken("gen", 60, 3)).toBe(false);

    resetDbForTests(); // close; the next takeToken reopens the same file under SAFELIGHT_DATA_DIR
    expect(takeToken("gen", 60, 3)).toBe(false);

    // …and refill still works from the persisted timestamp.
    vi.setSystemTime(T0 + 1_000);
    expect(takeToken("gen", 60, 3)).toBe(true);
  });

  it("gives a brand-new key its full burst immediately", () => {
    expect(takeToken("fresh", 1, 1)).toBe(true);
    expect(takeToken("fresh", 1, 1)).toBe(false);
    // 1/min: a full minute restores exactly one.
    vi.setSystemTime(T0 + 60_000);
    expect(takeToken("fresh", 1, 1)).toBe(true);
    expect(takeToken("fresh", 1, 1)).toBe(false);
  });
});
