// Cost estimates and the hard spending cap for paid dataset runs.

import type { LlmUsage } from "./llm.js";

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

function price(model: string): { input: number; output: number } {
  const p = PRICES[model];
  if (!p) throw new Error(`No price known for model ${model}; add it to eval/lib/cost.ts before running.`);
  return p;
}

export function costOf(model: string, usage: LlmUsage): number {
  const p = price(model);
  return (
    (usage.input_tokens * p.input +
      usage.cache_creation_input_tokens * p.input * 1.25 +
      usage.cache_read_input_tokens * p.input * 0.1 +
      usage.output_tokens * p.output) /
    1_000_000
  );
}

/** Rough token estimate for planning (about 3.5 characters per token for cs/sk/en text). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export interface PlannedCall {
  model: string;
  inputTokens: number;
  /** Includes thinking, which is billed as output. */
  outputTokens: number;
}

/** Deliberately pessimistic: ignores prompt caching, so real runs should cost less. */
export function estimateCost(calls: readonly PlannedCall[]): number {
  return calls.reduce(
    (sum, c) => sum + costOf(c.model, { ...ZERO, input_tokens: c.inputTokens, output_tokens: c.outputTokens }),
    0,
  );
}

const ZERO: LlmUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

export class BudgetExceeded extends Error {}

/**
 * Tracks spend against a cap. Before each call the caller reserves the call's estimated
 * cost; if spent + reserved + the new reservation would exceed the cap, no call is made.
 * Reservations make the cap safe with several calls in flight.
 */
export class Budget {
  private spentUsd = 0;
  private reservedUsd = 0;
  readonly totals: Record<string, LlmUsage & { calls: number }> = {};

  constructor(readonly capUsd: number) {}

  get spent(): number {
    return this.spentUsd;
  }

  reserve(estimateUsd: number): void {
    if (this.spentUsd + this.reservedUsd + estimateUsd > this.capUsd) {
      throw new BudgetExceeded(
        `Budget cap $${this.capUsd.toFixed(2)} reached (spent $${this.spentUsd.toFixed(4)}, in flight $${this.reservedUsd.toFixed(4)}).`,
      );
    }
    this.reservedUsd += estimateUsd;
  }

  settle(estimateUsd: number, model: string, usage: LlmUsage): void {
    this.reservedUsd = Math.max(0, this.reservedUsd - estimateUsd);
    this.spentUsd += costOf(model, usage);
    const t = (this.totals[model] ??= { ...ZERO, calls: 0 });
    t.calls++;
    t.input_tokens += usage.input_tokens;
    t.output_tokens += usage.output_tokens;
    t.cache_creation_input_tokens += usage.cache_creation_input_tokens;
    t.cache_read_input_tokens += usage.cache_read_input_tokens;
  }
}
