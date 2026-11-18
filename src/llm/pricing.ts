// Prices of the models this project uses, for cost reporting.

import type { LlmUsage } from "./client.js";

/**
 * USD per million tokens. Source: Anthropic first-party API prices as listed in the
 * claude-api reference (cached 2026-11-03). Cache writes are 1.25x input and cache
 * reads 0.1x input (5-minute cache). Update the date when prices are re-checked.
 */
export const PRICES_CHECKED = "2026-11-03";
export const PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export function hasPrice(model: string): boolean {
  return Object.hasOwn(PRICES, model);
}

/**
 * Cost of one call in USD, or null when the model has no known price. That happens after a
 * server-side fallback to a model picked by the API (P03 requirements.md, Notes).
 */
export function costOf(model: string, usage: LlmUsage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (
    (usage.input_tokens * p.input +
      usage.cache_creation_input_tokens * p.input * 1.25 +
      usage.cache_read_input_tokens * p.input * 0.1 +
      usage.output_tokens * p.output) /
    1_000_000
  );
}
