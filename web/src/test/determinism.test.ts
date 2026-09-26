import { afterEach, describe, expect, it, vi } from "vitest";
import { randomSeed } from "@/lib/presets";
import { freezeClock, seedMathRandom, sequentialUuids, withDeterminism } from "./determinism";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("determinism helpers", () => {
  it("seedMathRandom makes randomSeed() reproducible, and restore undoes it", () => {
    const restore = seedMathRandom(42);
    const first = [randomSeed(), randomSeed(), randomSeed()];
    restore();
    const restore2 = seedMathRandom(42);
    expect([randomSeed(), randomSeed(), randomSeed()]).toEqual(first);
    restore2();
    expect(first.every((n) => Number.isInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("different seeds diverge", () => {
    const r1 = seedMathRandom(1);
    const a = Math.random();
    r1();
    const r2 = seedMathRandom(2);
    expect(Math.random()).not.toBe(a);
    r2();
  });

  it("sequentialUuids issues valid, ordered UUIDs", () => {
    const restore = sequentialUuids();
    expect(crypto.randomUUID()).toBe("00000000-0000-4000-8000-000000000001");
    expect(crypto.randomUUID()).toBe("00000000-0000-4000-8000-000000000002");
    restore();
    expect(crypto.randomUUID()).not.toBe("00000000-0000-4000-8000-000000000003");
  });

  it("freezeClock pins Date.now and advance() fires timers exactly on schedule", () => {
    const clock = freezeClock("2026-01-02T03:04:05.000Z");
    expect(Date.now()).toBe(clock.now);
    expect(new Date().toISOString()).toBe("2026-01-02T03:04:05.000Z");
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 180_000);
    clock.advance(179_999);
    expect(fired).toBe(false);
    clock.advance(1);
    expect(fired).toBe(true);
    expect(Date.now()).toBe(clock.now + 180_000);
    clock.restore();
  });

  it("advanceAsync lets awaited timer chains settle", async () => {
    const clock = freezeClock();
    const done = new Promise<string>((resolve) => setTimeout(() => resolve("later"), 5_000));
    await clock.advanceAsync(5_000);
    await expect(done).resolves.toBe("later");
    clock.restore();
  });

  it("withDeterminism installs all three and one restore puts everything back", () => {
    const real = Date.now();
    const { clock, restore } = withDeterminism({ seed: 7, clock: "2026-06-01T00:00:00Z" });
    expect(Date.now()).toBe(clock.now);
    expect(crypto.randomUUID()).toBe("00000000-0000-4000-8000-000000000001");
    const seeded = Math.random();
    restore();
    expect(Math.abs(Date.now() - real)).toBeLessThan(60_000); // real clock again
    const r = seedMathRandom(7);
    expect(Math.random()).toBe(seeded); // same seed reproduces the seeded draw
    r();
  });
});
