// Shared CLI handling for paid runs: --dry-run, confirmation, --max-cost, --only,
// a small worker pool, and the run log.

import { createInterface } from "node:readline/promises";
import { appendJsonl } from "./jsonl.js";
import { Budget, BudgetExceeded, estimateCost, type PlannedCall } from "./cost.js";
import { ZERO_USAGE, type LlmClient, type LlmRequest, type LlmResult, type LlmUsage } from "../../src/llm/client.js";
import { PATHS } from "./paths.js";

export interface RunOptions {
  dryRun: boolean;
  yes: boolean;
  maxCost: number;
  concurrency: number;
  only: Set<string> | null;
}

export function parseRunOptions(argv: readonly string[]): RunOptions {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const maxCost = Number(value("--max-cost") ?? 10);
  const concurrency = Number(value("--concurrency") ?? 4);
  if (!(maxCost > 0)) throw new Error("--max-cost must be a positive number");
  if (!(concurrency >= 1)) throw new Error("--concurrency must be at least 1");
  const only = value("--only");
  return {
    dryRun: argv.includes("--dry-run"),
    yes: argv.includes("--yes"),
    maxCost,
    concurrency,
    only: only ? new Set(only.split(",").map((s) => s.trim())) : null,
  };
}

export type Confirm = (question: string) => Promise<boolean>;

export const ttyConfirm: Confirm = async (question) => {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
};

export interface Job<T> {
  id: string;
  planned: PlannedCall[];
  run: (budget: Budget) => Promise<T>;
}

export interface RunReport {
  script: string;
  dryRun: boolean;
  started: string;
  finished: string;
  jobsPlanned: number;
  jobsDone: number;
  estimatedUsd: number;
  spentUsd: number;
  stoppedByBudget: boolean;
  totals: Record<string, LlmUsage & { calls: number }>;
  note?: string;
}

/**
 * Runs paid jobs safely:
 * - dry run: prints the plan and estimate, makes no calls;
 * - otherwise asks for confirmation (or --yes), then runs with a worker pool and stops
 *   starting new jobs once the budget cap would be exceeded.
 */
export async function runPaidJobs<T>(
  script: string,
  jobs: readonly Job<T>[],
  options: RunOptions,
  confirm: Confirm = ttyConfirm,
  log: (line: string) => void = console.log,
  onResult: (id: string, result: T) => void = () => {},
): Promise<RunReport> {
  const started = new Date().toISOString();
  const estimated = estimateCost(jobs.flatMap((j) => j.planned));
  const calls = jobs.reduce((n, j) => n + j.planned.length, 0);
  const byModel: Record<string, number> = {};
  for (const c of jobs.flatMap((j) => j.planned)) byModel[c.model] = (byModel[c.model] ?? 0) + 1;

  log(
    `${script}: ${jobs.length} jobs, ${calls} model calls (${Object.entries(byModel)
      .map(([m, n]) => `${m} x${n}`)
      .join(", ")}).`,
  );
  log(`Estimated cost: $${estimated.toFixed(2)} without retries or caching. Cap: $${options.maxCost.toFixed(2)}.`);

  const base = { script, started, jobsPlanned: jobs.length, estimatedUsd: estimated };
  if (options.dryRun || jobs.length === 0) {
    log(options.dryRun ? "Dry run: no model calls made." : "Nothing to do.");
    return {
      ...base,
      dryRun: options.dryRun,
      finished: new Date().toISOString(),
      jobsDone: 0,
      spentUsd: 0,
      stoppedByBudget: false,
      totals: {},
    };
  }
  if (!options.yes && !(await confirm(`Run ${calls} paid model calls (est. $${estimated.toFixed(2)})?`))) {
    log("Not confirmed: no model calls made.");
    return {
      ...base,
      dryRun: true,
      finished: new Date().toISOString(),
      jobsDone: 0,
      spentUsd: 0,
      stoppedByBudget: false,
      totals: {},
      note: "not confirmed",
    };
  }

  const budget = new Budget(options.maxCost);
  let next = 0;
  let done = 0;
  let stoppedByBudget = false;
  const worker = async (): Promise<void> => {
    while (!stoppedByBudget && next < jobs.length) {
      const job = jobs[next++]!;
      try {
        const result = await job.run(budget);
        onResult(job.id, result);
        done++;
        if (done % 10 === 0 || done === jobs.length)
          log(`  ${done}/${jobs.length} done, spent $${budget.spent.toFixed(2)}`);
      } catch (error) {
        if (error instanceof BudgetExceeded) {
          stoppedByBudget = true;
          log(`Stopped: ${error.message}`);
        } else {
          throw error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, worker));

  const report: RunReport = {
    ...base,
    dryRun: false,
    finished: new Date().toISOString(),
    jobsDone: done,
    spentUsd: budget.spent,
    stoppedByBudget,
    totals: budget.totals,
  };
  log(`Done: ${done}/${jobs.length} jobs, spent $${budget.spent.toFixed(2)}.`);
  return report;
}

/**
 * One model call under the budget: reserves the estimate first (throws BudgetExceeded
 * without calling), then settles the real usage. Priced by the requested model.
 */
export async function callWithBudget(
  client: LlmClient,
  budget: Budget,
  request: LlmRequest,
  planned: PlannedCall,
): Promise<LlmResult> {
  const estimate = estimateCost([planned]);
  budget.reserve(estimate);
  let usage = ZERO_USAGE;
  try {
    const result = await client.complete(request);
    usage = result.usage;
    return result;
  } finally {
    budget.settle(estimate, request.model, usage);
  }
}

export function logRun(report: RunReport, path: string = PATHS.runLog): void {
  if (!report.dryRun) appendJsonl(path, report);
}
