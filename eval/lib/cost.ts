// Cost estimates and the hard spending cap for paid dataset runs.

import type { LlmUsage } from "../../src/llm/client.js";
import { costOf as pipelineCostOf } from "../../src/llm/pricing.js";

export { PRICES, PRICES_CHECKED } from "../../src/llm/pricing.js";

/** Like the pipeline's costOf, but an unknown model is an error: paid dataset runs need a cap. */
export function costOf(model: string, usage: LlmUsage): number {
  const cost = pipelineCostOf(model, usage);
  if (cost === null) throw new Error(`No price known for model ${model}; add it to src/llm/pricing.ts before running.`);
  return cost;
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

const ZERO: LlmUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

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
