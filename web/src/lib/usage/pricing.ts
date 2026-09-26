/**
 * Maintained pricing table for the models Safelight routes, in USD per million
 * tokens. Checked against the providers' published price lists — update the
 * numbers here when a provider moves them; nothing else has prices hardcoded.
 *
 * Matching is longest-prefix over a normalized model id, so dated snapshots
 * ("claude-sonnet-4-5-20250929") and vendor-prefixed OpenRouter ids
 * ("anthropic/claude-sonnet-4.5") resolve to the same row. OpenRouter and Groq
 * are otherwise pass-through: when an OpenRouter response carries usage.cost we
 * trust it over the table. Unknown models cost 0 and are flagged "unpriced" so
 * the Usage page can say so instead of silently under-counting.
 */

export interface TokenPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

/** Keys are normalized prefixes: lowercase, dots-as-dashes, no vendor prefix. */
const TOKEN_PRICES: Record<string, TokenPrice> = {
  // OpenAI — gpt-5 family
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5-pro": { input: 15, output: 120 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-5-1": { input: 1.25, output: 10 },
  "gpt-4-1-mini": { input: 0.4, output: 1.6 },
  "gpt-4-1": { input: 2, output: 8 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  // Anthropic — current generation
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  // Google — gemini 3 family (and the 2.5 line still routed)
  "gemini-3-pro": { input: 2, output: 12 },
  "gemini-3-flash": { input: 0.3, output: 2.5 },
  "gemini-2-5-pro": { input: 1.25, output: 10 },
  "gemini-2-5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2-5-flash": { input: 0.3, output: 2.5 },
  // Groq-hosted open models (per Groq's price list)
  "llama-3-3-70b-versatile": { input: 0.59, output: 0.79 },
  "llama-3-1-8b-instant": { input: 0.05, output: 0.08 },
  "qwen-2-5-72b": { input: 0.9, output: 0.9 },
};

/** Cloud image models, USD per image; local renders are free. */
const IMAGE_PRICES: Record<string, number> = {
  "gpt-image-1-mini": 0.011,
  "gpt-image-1": 0.042,
  "dall-e-3": 0.04,
  "gemini-2-5-flash-image": 0.039,
  "imagen-4": 0.04,
};

const PROVIDERS_NEVER_BILLED = new Set(["ollama", "local", "comfy"]);

/** Lowercase, strip an OpenRouter-style vendor prefix, and fold dots into dashes. */
export function normalizeModel(model: string): string {
  let m = model.trim().toLowerCase();
  const slash = m.lastIndexOf("/");
  if (slash >= 0) m = m.slice(slash + 1);
  return m.replace(/\./g, "-");
}

function longestPrefix<T>(table: Record<string, T>, model: string): T | undefined {
  const norm = normalizeModel(model);
  let best: { key: string; value: T } | undefined;
  for (const [key, value] of Object.entries(table)) {
    if (norm.startsWith(key) && (!best || key.length > best.key.length)) best = { key, value };
  }
  return best?.value;
}

export function lookupTokenPrice(model: string): TokenPrice | undefined {
  return longestPrefix(TOKEN_PRICES, model);
}

export function lookupImagePrice(model: string): number | undefined {
  return longestPrefix(IMAGE_PRICES, model);
}

export interface PricedCall {
  cost: number;
  /** True when we billed 0 only because the model is missing from the table. */
  unpriced: boolean;
}

export function priceCall(call: { provider: string; model: string; inputTokens?: number; outputTokens?: number; images?: number; providerCost?: number }): PricedCall {
  if (PROVIDERS_NEVER_BILLED.has(call.provider)) return { cost: 0, unpriced: false };
  // OpenRouter sometimes reports the exact charge; trust it when present.
  if (typeof call.providerCost === "number" && Number.isFinite(call.providerCost)) return { cost: call.providerCost, unpriced: false };
  const inputTokens = call.inputTokens ?? 0;
  const outputTokens = call.outputTokens ?? 0;
  const images = call.images ?? 0;
  let cost = 0;
  let priced = false;
  let hadUsage = false;
  if (inputTokens > 0 || outputTokens > 0) {
    hadUsage = true;
    const p = lookupTokenPrice(call.model);
    if (p) {
      priced = true;
      cost += (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
    }
  }
  if (images > 0) {
    hadUsage = true;
    const per = lookupImagePrice(call.model);
    if (per !== undefined) {
      priced = true;
      cost += images * per;
    }
  }
  return { cost, unpriced: hadUsage && !priced };
}

/** Providers whose usage never counts toward spend limits. */
export function isLocalProvider(provider: string): boolean {
  return PROVIDERS_NEVER_BILLED.has(provider);
}
