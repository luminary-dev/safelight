import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveApproval, waitForApproval } from "./approvals";

/**
 * approvals.ts is the Allow/Deny gate between a running agent and destructive tools
 * (TEST-BRIEF §6, §15). Timers are faked; ids are unique per test because the pending
 * map is module state.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Tracks settlement without awaiting, so "still pending" is assertable. */
function track(p: Promise<boolean>): { get settled(): boolean; get value(): boolean | undefined } {
  let settled = false;
  let value: boolean | undefined;
  void p.then((v) => {
    settled = true;
    value = v;
  });
  return {
    get settled() {
      return settled;
    },
    get value() {
      return value;
    },
  };
}

describe("resolveApproval", () => {
  it("returns false for an id nobody is waiting on", () => {
    expect(resolveApproval("never-created", true)).toBe(false);
  });

  it("resolves the waiter with Allow and reports success", async () => {
    const p = waitForApproval("allow-1");
    expect(resolveApproval("allow-1", true)).toBe(true);
    await expect(p).resolves.toBe(true);
  });

  it("resolves the waiter with Deny", async () => {
    const p = waitForApproval("deny-1");
    expect(resolveApproval("deny-1", false)).toBe(true);
    await expect(p).resolves.toBe(false);
  });

  it("is a no-op returning false the second time — the first answer stands", async () => {
    const p = waitForApproval("double-1");
    expect(resolveApproval("double-1", false)).toBe(true);
    expect(resolveApproval("double-1", true)).toBe(false);
    await expect(p).resolves.toBe(false);
  });

  it("removes the entry, so a resolved id cannot be replayed later", async () => {
    const p = waitForApproval("replay-1");
    resolveApproval("replay-1", true);
    await p;
    expect(resolveApproval("replay-1", true)).toBe(false);
  });
});

describe("timeout", () => {
  it("stays pending until 180 s, then resolves the waiter to deny", async () => {
    const state = track(waitForApproval("timeout-1"));
    await vi.advanceTimersByTimeAsync(179_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    expect(state.value).toBe(false);
  });

  it("removes the timed-out entry, so a late Allow returns false and changes nothing", async () => {
    const p = waitForApproval("timeout-2");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(resolveApproval("timeout-2", true)).toBe(false);
    await expect(p).resolves.toBe(false);
  });

  it("honors a custom timeout", async () => {
    const state = track(waitForApproval("timeout-3", 5_000));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.settled).toBe(true);
    expect(state.value).toBe(false);
  });

  it("does not fire after an explicit answer — Allow within the window wins", async () => {
    const p = waitForApproval("timeout-4");
    resolveApproval("timeout-4", true);
    await vi.advanceTimersByTimeAsync(180_000);
    await expect(p).resolves.toBe(true);
  });
});

describe("concurrency", () => {
  it("resolves pending approvals independently and never cross-resolves", async () => {
    const a = track(waitForApproval("conc-a"));
    const b = track(waitForApproval("conc-b"));
    const c = track(waitForApproval("conc-c"));

    expect(resolveApproval("conc-b", true)).toBe(true);
    await Promise.resolve();
    expect(b.settled).toBe(true);
    expect(b.value).toBe(true);
    expect(a.settled).toBe(false);
    expect(c.settled).toBe(false);

    expect(resolveApproval("conc-a", false)).toBe(true);
    await Promise.resolve();
    expect(a.value).toBe(false);
    expect(c.settled).toBe(false);

    // The one left behind still times out to deny on its own clock.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(c.value).toBe(false);
  });
});
