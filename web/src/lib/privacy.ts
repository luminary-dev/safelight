import "server-only";
import { getSetting } from "@/lib/db/settings";
import { getLogger } from "@/lib/log";

/**
 * The "Local only" master switch. When on, every outbound network feature refuses to run
 * with the same clear message, and each refusal is logged so the user can audit what tried
 * to leave the machine. Loopback targets stay allowed — local servers are the product.
 */

const KEY = "localOnly";
let cache: { value: boolean; at: number } | null = null;

export function isLocalOnly(): boolean {
  const now = Date.now();
  if (cache && now - cache.at < 2000) return cache.value;
  const value = getSetting<boolean>(KEY, false);
  cache = { value, at: now };
  return value;
}

/** Tests and the settings route flip the switch; drop the read cache with it. */
export function invalidateLocalOnlyCache() {
  cache = null;
}

export function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost") || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * Throws when Local only is on and the target is not this machine. `feature` names what was
 * blocked in the error and the audit log ("cloud chat", "web search", "model download", …).
 */
export function assertOutboundAllowed(feature: string, url?: string): void {
  if (!isLocalOnly()) return;
  if (url && isLoopbackUrl(url)) return;
  getLogger().warn({ feature, target: url ? new URL(url).hostname : undefined }, "local-only blocked an outbound call");
  throw new Error(`Local only is on — ${feature} is disabled. Turn it off in Settings to use it.`);
}
