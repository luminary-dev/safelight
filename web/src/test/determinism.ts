import { vi } from "vitest";

/**
 * Determinism helpers (TEST-BRIEF §0.2: deterministic or deleted).
 *
 *   const clock = freezeClock("2026-01-02T03:04:05Z");  // fake timers, Date.now frozen
 *   clock.advance(180_000);                             // run pending timers 3 min forward
 *   clock.restore();
 *
 *   const restoreRandom = seedMathRandom(42);   // Math.random → seeded PRNG (randomSeed())
 *   const restoreUuid = sequentialUuids();      // crypto.randomUUID → …-000000000001, -…002
 *
 *   const restoreAll = withDeterminism();       // all three at once
 *
 * All helpers are vi.spyOn-based: restore() puts the real implementation back,
 * and vi.restoreAllMocks() also cleans them up.
 */

/** mulberry32 — a tiny, well-distributed seeded PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeds Math.random (and with it lib/presets' randomSeed()). Returns restore. */
export function seedMathRandom(seed = 1): () => void {
  const rng = mulberry32(seed);
  const spy = vi.spyOn(Math, "random").mockImplementation(rng);
  return () => spy.mockRestore();
}

/** crypto.randomUUID returns 00000000-0000-4000-8000-000000000001, …002, … Returns restore. */
export function sequentialUuids(start = 1): () => void {
  let n = start - 1;
  const spy = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`;
  });
  return () => spy.mockRestore();
}

export interface FrozenClock {
  /** The frozen epoch at install time. */
  now: number;
  /** Moves time forward, firing any timers due in the window. */
  advance(ms: number): void;
  /** Moves time forward asynchronously, letting awaited timer chains settle. */
  advanceAsync(ms: number): Promise<void>;
  restore(): void;
}

/** Installs vi fake timers with a frozen Date.now, so createdAt/updatedAt assertions are exact. */
export function freezeClock(at: number | string | Date = "2026-01-01T00:00:00.000Z"): FrozenClock {
  const now = new Date(at).getTime();
  vi.useFakeTimers({ now });
  return {
    now,
    advance: (ms) => {
      vi.advanceTimersByTime(ms);
    },
    advanceAsync: async (ms) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
    restore: () => vi.useRealTimers(),
  };
}

export interface DeterminismOptions {
  seed?: number;
  uuidStart?: number;
  clock?: number | string | Date;
}

/** Frozen clock + seeded Math.random + sequential UUIDs. Returns one restore for all. */
export function withDeterminism(opts: DeterminismOptions = {}): { clock: FrozenClock; restore(): void } {
  const clock = freezeClock(opts.clock ?? "2026-01-01T00:00:00.000Z");
  const restoreRandom = seedMathRandom(opts.seed ?? 1);
  const restoreUuid = sequentialUuids(opts.uuidStart ?? 1);
  return {
    clock,
    restore: () => {
      restoreUuid();
      restoreRandom();
      clock.restore();
    },
  };
}
