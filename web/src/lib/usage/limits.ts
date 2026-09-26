import "server-only";
import { getDb } from "@/lib/db";
import { getSetting } from "@/lib/db/settings";
import { spentSince } from "./record";

/**
 * Spend limits, read from the settings table. All keys are numbers in USD and
 * unset means the limit is off. Soft limits warn once per run; hard limits
 * stop the run before the next provider round. Local providers never count —
 * the ledger sums already exclude them (see spentSince).
 *
 * Besides the four global keys there are per-provider limits under
 * `spendLimit:<provider>:daySoft|dayHard|monthSoft|monthHard`, checked
 * alongside the global ones with the same semantics; their messages name the
 * provider.
 */

export const SPEND_LIMIT_KEYS = {
  daySoft: "spendLimitDaySoft",
  dayHard: "spendLimitDayHard",
  monthSoft: "spendLimitMonthSoft",
  monthHard: "spendLimitMonthHard",
} as const;

export type SpendLimitWindow = keyof typeof SPEND_LIMIT_KEYS;

/** Settings key for one provider's limit, e.g. spendLimit:openai:dayHard. */
export function providerLimitKey(provider: string, window: SpendLimitWindow): string {
  return `spendLimit:${provider}:${window}`;
}

export interface SpendGate {
  /** Set when a hard limit is reached; the loop stops with this status. */
  stop?: string;
  /** Set when a soft limit is passed; emitted once per run. */
  warn?: string;
  spentToday: number;
  spentThisMonth: number;
}

function limit(key: string): number | undefined {
  const v = getSetting<unknown>(key, null);
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function usd(n: number): string {
  return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

export function startOfDay(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfMonth(now = Date.now()): number {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** One provider's cloud spend (USD) inside a window. Same shape as spentSince, filtered. */
function providerSpentSince(provider: string, ts: number, now: number): number {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(cost), 0) AS total FROM usage_events WHERE ts >= ? AND ts <= ? AND provider = ?")
    .get(ts, now, provider) as { total: number };
  return row.total;
}

/**
 * Sums the ledger and compares against the configured limits — the four global
 * keys always, plus `provider`'s own keys when given. Hard limits win over soft
 * ones and global checks run before per-provider ones. Cheap: indexed SUMs.
 */
export function checkSpendLimits(now = Date.now(), provider?: string): SpendGate {
  const spentToday = spentSince(startOfDay(now), now);
  const spentThisMonth = spentSince(startOfMonth(now), now);
  const gate: SpendGate = { spentToday, spentThisMonth };

  const dayHard = limit(SPEND_LIMIT_KEYS.dayHard);
  const monthHard = limit(SPEND_LIMIT_KEYS.monthHard);
  if (dayHard !== undefined && spentToday >= dayHard) {
    gate.stop = `Stopped: the daily spend limit of ${usd(dayHard)} is reached — raise it in settings.`;
    return gate;
  }
  if (monthHard !== undefined && spentThisMonth >= monthHard) {
    gate.stop = `Stopped: the monthly spend limit of ${usd(monthHard)} is reached — raise it in settings.`;
    return gate;
  }

  // Per-provider limits: only computed when a key is actually set, so the
  // common case (no per-provider limits) costs nothing extra.
  let providerToday: number | undefined;
  let providerMonth: number | undefined;
  const providerSpent = (window: "day" | "month"): number => {
    if (!provider) return 0;
    if (window === "day") return (providerToday ??= providerSpentSince(provider, startOfDay(now), now));
    return (providerMonth ??= providerSpentSince(provider, startOfMonth(now), now));
  };
  const pDayHard = provider ? limit(providerLimitKey(provider, "dayHard")) : undefined;
  const pMonthHard = provider ? limit(providerLimitKey(provider, "monthHard")) : undefined;
  if (provider && pDayHard !== undefined && providerSpent("day") >= pDayHard) {
    gate.stop = `Stopped: the daily ${provider} spend limit of ${usd(pDayHard)} is reached — raise it in settings.`;
    return gate;
  }
  if (provider && pMonthHard !== undefined && providerSpent("month") >= pMonthHard) {
    gate.stop = `Stopped: the monthly ${provider} spend limit of ${usd(pMonthHard)} is reached — raise it in settings.`;
    return gate;
  }

  const daySoft = limit(SPEND_LIMIT_KEYS.daySoft);
  const monthSoft = limit(SPEND_LIMIT_KEYS.monthSoft);
  const pDaySoft = provider ? limit(providerLimitKey(provider, "daySoft")) : undefined;
  const pMonthSoft = provider ? limit(providerLimitKey(provider, "monthSoft")) : undefined;
  if (daySoft !== undefined && spentToday >= daySoft) {
    gate.warn = `Heads up: today's spend (${usd(spentToday)}) has passed the soft limit of ${usd(daySoft)}.`;
  } else if (monthSoft !== undefined && spentThisMonth >= monthSoft) {
    gate.warn = `Heads up: this month's spend (${usd(spentThisMonth)}) has passed the soft limit of ${usd(monthSoft)}.`;
  } else if (provider && pDaySoft !== undefined && providerSpent("day") >= pDaySoft) {
    gate.warn = `Heads up: today's ${provider} spend (${usd(providerSpent("day"))}) has passed the soft limit of ${usd(pDaySoft)}.`;
  } else if (provider && pMonthSoft !== undefined && providerSpent("month") >= pMonthSoft) {
    gate.warn = `Heads up: this month's ${provider} spend (${usd(providerSpent("month"))}) has passed the soft limit of ${usd(pMonthSoft)}.`;
  }
  return gate;
}
