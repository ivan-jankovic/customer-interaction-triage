import { describe, expect, it } from "vitest";
import { Budget, BudgetExceeded, costOf, estimateCost } from "../../eval/lib/cost.js";
import { callWithBudget, parseRunOptions, runPaidJobs, type Job, type RunOptions } from "../../eval/lib/run-guard.js";
import { mockLlm, USAGE } from "./mock-llm.js";

const opts = (o: Partial<RunOptions> = {}): RunOptions => ({
  dryRun: false,
  yes: true,
  maxCost: 10,
  concurrency: 2,
  only: null,
  ...o,
});

const silent = (): void => {};
const request = { model: "claude-haiku-5-5", system: "s", user: "u", maxTokens: 100, effort: "low" as const };
const planned = { model: "claude-haiku-5-5", inputTokens: 1000, outputTokens: 500 };

function jobs(n: number, client = mockLlm(() => "ok")): { jobs: Job<string>[]; client: ReturnType<typeof mockLlm> } {
  return {
    client,
    jobs: Array.from({ length: n }, (_, i) => ({
      id: `j${i}`,
      planned: [planned],
      run: async (budget: Budget) => {
        const r = await callWithBudget(client, budget, request, planned);
        return r.ok ? r.text : r.error;
      },
    })),
  };
}

describe("cost", () => {
  it("prices usage by model, including cache reads and writes", () => {
    expect(costOf("claude-opus-5-5", { ...USAGE, input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(4);
    expect(costOf("claude-sonnet-5-5", { ...USAGE, input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(10);
    expect(
      costOf("claude-haiku-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }),
    ).toBeCloseTo(0.1 * 1.25 + 0.1 * 0.1);
  });

  it("refuses to price an unknown model", () => {
    expect(() => costOf("some-other-model", USAGE)).toThrow(/No price known/);
  });

  it("sums the usage of settled calls", () => {
    const budget = new Budget(1);
    budget.reserve(0.01);
    budget.settle(0.01, "claude-haiku-5-5", USAGE);
    budget.reserve(0.01);
    budget.settle(0.01, "claude-haiku-5-5", USAGE);
    expect(budget.totals["claude-haiku-5-5"]).toMatchObject({ calls: 2, input_tokens: 2000, output_tokens: 1000 });
    expect(budget.spent).toBeCloseTo(2 * costOf("claude-haiku-5-5", USAGE));
  });

  it("throws before exceeding the cap, counting in-flight reservations", () => {
    const budget = new Budget(0.05);
    budget.reserve(0.03);
    expect(() => budget.reserve(0.03)).toThrow(BudgetExceeded);
  });
});

describe("runPaidJobs", () => {
  it("makes no calls on a dry run", async () => {
    const { jobs: js, client } = jobs(5);
    const report = await runPaidJobs("test", js, opts({ dryRun: true }), () => Promise.resolve(true), silent);
    expect(client.calls).toHaveLength(0);
    expect(report.dryRun).toBe(true);
    expect(report.estimatedUsd).toBeCloseTo(5 * estimateCost([planned]));
  });

  it("makes no calls when not confirmed", async () => {
    const { jobs: js, client } = jobs(3);
    const report = await runPaidJobs("test", js, opts({ yes: false }), () => Promise.resolve(false), silent);
    expect(client.calls).toHaveLength(0);
    expect(report.note).toBe("not confirmed");
  });

  it("runs every job when confirmed and reports results", async () => {
    const { jobs: js, client } = jobs(5);
    const results: string[] = [];
    const report = await runPaidJobs("test", js, opts(), () => Promise.resolve(true), silent, (id) => results.push(id));
    expect(client.calls).toHaveLength(5);
    expect(results.sort()).toEqual(["j0", "j1", "j2", "j3", "j4"]);
    expect(report.spentUsd).toBeCloseTo(5 * costOf("claude-haiku-5-5", USAGE));
  });

  it("stops at the cap without going over it", async () => {
    const perCall = estimateCost([planned]);
    const cap = perCall * 3.5;
    const { jobs: js, client } = jobs(10);
    const report = await runPaidJobs("test", js, opts({ maxCost: cap, concurrency: 1 }), () => Promise.resolve(true), silent);
    expect(report.stoppedByBudget).toBe(true);
    expect(client.calls).toHaveLength(3);
    expect(report.spentUsd).toBeLessThanOrEqual(cap);
  });

  it("parses run options", () => {
    const o = parseRunOptions(["--dry-run", "--max-cost", "2.5", "--only", "msg-001, msg-002"]);
    expect(o).toMatchObject({ dryRun: true, yes: false, maxCost: 2.5, concurrency: 4 });
    expect([...o.only!]).toEqual(["msg-001", "msg-002"]);
    expect(() => parseRunOptions(["--max-cost", "0"])).toThrow();
  });
});
