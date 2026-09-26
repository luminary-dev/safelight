import { describe, expect, it } from "vitest";
import invoice from "./fixtures/invoice-lines.json";
import { priceCall } from "./pricing";

/**
 * Invoice reconciliation (docs/quality-gates.md gate 10, TEST-BRIEF §10):
 * hand-written invoice lines shaped like real provider billing exports,
 * checked against the computed cost. Every line — and the grand total — must
 * land within 5 % of what the provider invoiced, or the pricing table has
 * drifted from the providers' price lists and needs updating.
 */

interface InvoiceLine {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  images?: number;
  providerCost?: number;
  invoicedUsd: number;
  note?: string;
}

const LINES = (invoice as { lines: InvoiceLine[] }).lines;
const TOLERANCE = 0.05;

describe("invoice reconciliation within 5%", () => {
  it("covers a meaningful slice of the routed providers", () => {
    expect(LINES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(LINES.map((l) => l.provider)).size).toBeGreaterThanOrEqual(6);
  });

  it.each(LINES.map((l) => [`${l.provider} ${l.model} → $${l.invoicedUsd}`, l] as const))("reconciles %s", (_label, line) => {
    const { cost, unpriced } = priceCall(line);
    expect(unpriced, `${line.model} is missing from the pricing table`).toBe(false);
    const drift = Math.abs(cost - line.invoicedUsd) / line.invoicedUsd;
    expect(drift, `computed $${cost.toFixed(4)} vs invoiced $${line.invoicedUsd} (${(drift * 100).toFixed(2)}% off${line.note ? ` — ${line.note}` : ""})`).toBeLessThanOrEqual(
      TOLERANCE,
    );
  });

  it("reconciles the whole invoice total within 5%", () => {
    const computed = LINES.reduce((sum, l) => sum + priceCall(l).cost, 0);
    const invoiced = LINES.reduce((sum, l) => sum + l.invoicedUsd, 0);
    const drift = Math.abs(computed - invoiced) / invoiced;
    expect(drift, `computed $${computed.toFixed(2)} vs invoiced $${invoiced.toFixed(2)}`).toBeLessThanOrEqual(TOLERANCE);
  });

  it("a provider-reported charge reconciles exactly, not just within tolerance", () => {
    const openrouter = LINES.find((l) => l.providerCost !== undefined)!;
    expect(priceCall(openrouter).cost).toBe(openrouter.invoicedUsd);
  });
});
