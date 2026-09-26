import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { setSetting } from "@/lib/db/settings";
import { checkSpendLimits, providerLimitKey, SPEND_LIMIT_KEYS, startOfDay, startOfMonth } from "./limits";
import { recordUsage } from "./record";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-limits-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

// Mid-month, mid-day, so "earlier today" and "earlier this month" both exist.
const NOW = new Date(2026, 8, 15, 12, 0, 0).getTime();

/** A ledger row with a known cost: claude-haiku-4-5 input is $1/Mtok. */
function spend(usd: number, ts: number, provider = "anthropic") {
  recordUsage({ provider, model: "claude-haiku-4-5", mode: "agent", inputTokens: usd * 1_000_000, outputTokens: 0, ts });
}

describe("spend limits", () => {
  it("is wide open when no limits are set", () => {
    spend(1000, NOW - 1000);
    const gate = checkSpendLimits(NOW);
    expect(gate.stop).toBeUndefined();
    expect(gate.warn).toBeUndefined();
    expect(gate.spentToday).toBeCloseTo(1000, 6);
  });

  it("stops at the daily hard limit with a clear message", () => {
    setSetting(SPEND_LIMIT_KEYS.dayHard, 5);
    spend(5, startOfDay(NOW) + 1000);
    const gate = checkSpendLimits(NOW);
    expect(gate.stop).toBe("Stopped: the daily spend limit of $5 is reached — raise it in settings.");
  });

  it("stops at the monthly hard limit even when today is fine", () => {
    setSetting(SPEND_LIMIT_KEYS.dayHard, 100);
    setSetting(SPEND_LIMIT_KEYS.monthHard, 20);
    spend(19, startOfMonth(NOW) + 1000); // earlier this month, not today
    spend(2, startOfDay(NOW) + 1000);
    const gate = checkSpendLimits(NOW);
    expect(gate.spentToday).toBeCloseTo(2, 6);
    expect(gate.stop).toBe("Stopped: the monthly spend limit of $20 is reached — raise it in settings.");
  });

  it("warns at the soft limit without stopping", () => {
    setSetting(SPEND_LIMIT_KEYS.daySoft, 1);
    setSetting(SPEND_LIMIT_KEYS.dayHard, 50);
    spend(2, startOfDay(NOW) + 1000);
    const gate = checkSpendLimits(NOW);
    expect(gate.stop).toBeUndefined();
    expect(gate.warn).toContain("soft limit of $1");
  });

  it("never counts local providers", () => {
    setSetting(SPEND_LIMIT_KEYS.dayHard, 1);
    recordUsage({ provider: "ollama", model: "qwen2.5", mode: "agent", inputTokens: 50_000_000, outputTokens: 50_000_000, ts: NOW - 1000 });
    recordUsage({ provider: "local", model: "qwen-image", mode: "agent", images: 40, ts: NOW - 1000 });
    const gate = checkSpendLimits(NOW);
    expect(gate.stop).toBeUndefined();
    expect(gate.spentToday).toBe(0);
  });

  it("only counts spend inside the window (yesterday hits the month, not the day)", () => {
    setSetting(SPEND_LIMIT_KEYS.dayHard, 5);
    spend(10, startOfDay(NOW) - 1000); // yesterday
    const gate = checkSpendLimits(NOW);
    expect(gate.spentToday).toBe(0);
    expect(gate.spentThisMonth).toBeCloseTo(10, 6);
    expect(gate.stop).toBeUndefined();
  });

  it("ignores non-numeric limit values", () => {
    setSetting(SPEND_LIMIT_KEYS.dayHard, "nonsense");
    spend(50, NOW - 1000);
    expect(checkSpendLimits(NOW).stop).toBeUndefined();
  });
});

describe("per-provider spend limits", () => {
  it("builds the documented settings keys", () => {
    expect(providerLimitKey("openai", "dayHard")).toBe("spendLimit:openai:dayHard");
    expect(providerLimitKey("anthropic", "monthSoft")).toBe("spendLimit:anthropic:monthSoft");
  });

  it("stops at a provider's daily hard limit, naming the provider", () => {
    setSetting(providerLimitKey("anthropic", "dayHard"), 3);
    spend(3, startOfDay(NOW) + 1000, "anthropic");
    const gate = checkSpendLimits(NOW, "anthropic");
    expect(gate.stop).toBe("Stopped: the daily anthropic spend limit of $3 is reached — raise it in settings.");
  });

  it("stops at a provider's monthly hard limit even when today is fine", () => {
    setSetting(providerLimitKey("anthropic", "monthHard"), 10);
    spend(10, startOfMonth(NOW) + 1000, "anthropic"); // earlier this month, not today
    const gate = checkSpendLimits(NOW, "anthropic");
    expect(gate.stop).toBe("Stopped: the monthly anthropic spend limit of $10 is reached — raise it in settings.");
  });

  it("only counts THAT provider's spend, and only gates runs on that provider", () => {
    setSetting(providerLimitKey("anthropic", "dayHard"), 1);
    spend(5, NOW - 1000, "openai"); // someone else's spend
    expect(checkSpendLimits(NOW, "anthropic").stop).toBeUndefined();
    spend(2, NOW - 1000, "anthropic");
    expect(checkSpendLimits(NOW, "anthropic").stop).toContain("anthropic");
    // A different provider's run sails past this limit (global limits unset).
    expect(checkSpendLimits(NOW, "openai").stop).toBeUndefined();
    // No provider given (legacy callers): only global limits apply.
    expect(checkSpendLimits(NOW).stop).toBeUndefined();
  });

  it("warns at a provider soft limit without stopping, after the global softs", () => {
    setSetting(providerLimitKey("anthropic", "daySoft"), 1);
    spend(2, startOfDay(NOW) + 1000, "anthropic");
    const gate = checkSpendLimits(NOW, "anthropic");
    expect(gate.stop).toBeUndefined();
    expect(gate.warn).toBe("Heads up: today's anthropic spend ($2) has passed the soft limit of $1.");

    // A global soft limit takes message precedence over the provider one.
    setSetting(SPEND_LIMIT_KEYS.daySoft, 1);
    expect(checkSpendLimits(NOW, "anthropic").warn).toContain("today's spend");
  });

  it("a global hard limit still wins over a looser provider limit", () => {
    setSetting(SPEND_LIMIT_KEYS.dayHard, 2);
    setSetting(providerLimitKey("anthropic", "dayHard"), 100);
    spend(2, startOfDay(NOW) + 1000, "anthropic");
    const gate = checkSpendLimits(NOW, "anthropic");
    expect(gate.stop).toBe("Stopped: the daily spend limit of $2 is reached — raise it in settings.");
  });
});
