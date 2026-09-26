import "server-only";
import { getSetting } from "@/lib/db/settings";
import { spentSince } from "./record";

/**
 * Spend limits, read from the settings table. All four keys are numbers in USD
 * and unset means the limit is off. Soft limits warn once per run; hard limits
 * stop the run before the next provider round. Local providers never count —
 * the ledger sums already exclude them (see spentSince).
 */

export const SPEND_LIMIT_KEYS = {
  daySoft: "spendLimitDaySoft",
  dayHard: "spendLimitDayHard",
  monthSoft: "spendLimitMonthSoft",
  monthHard: "spendLimitMonthHard",
} as const;

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

/** Sums the ledger and compares against the configured limits. Cheap: two indexed SUMs. */
export function checkSpendLimits(now = Date.now()): SpendGate {
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

  const daySoft = limit(SPEND_LIMIT_KEYS.daySoft);
  const monthSoft = limit(SPEND_LIMIT_KEYS.monthSoft);
  if (daySoft !== undefined && spentToday >= daySoft) {
    gate.warn = `Heads up: today's spend (${usd(spentToday)}) has passed the soft limit of ${usd(daySoft)}.`;
  } else if (monthSoft !== undefined && spentThisMonth >= monthSoft) {
    gate.warn = `Heads up: this month's spend (${usd(spentThisMonth)}) has passed the soft limit of ${usd(monthSoft)}.`;
  }
  return gate;
}
