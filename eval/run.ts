// npm run eval [-- --subset small] [--dry-run] [--yes] [--max-cost 3] [--concurrency 4]
//
// Classifies every message of a set with the pipeline's understanding step, grades each valid
// summary with the summary judge, and writes a run folder in eval/results/ (P04). Paid: the
// run guard prints an estimate and asks before any call (or takes --yes), and stops starting
// new messages at the --max-cost cap. Each message's line is written as soon as it is done, so
// a stopped run keeps what it paid for.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { loadClassifierConfig } from "../src/config.js";
import { createAnthropicClient, type LlmClient, type LlmRequest } from "../src/llm/client.js";
import { loadPrompt } from "../src/llm/prompts.js";
import { mask, MASKER_VERSION } from "../src/pipeline/mask.js";
import { buildRequest, CLASSIFY_MAX_TOKENS, CLASSIFY_PROMPT_VERSION, understand } from "../src/pipeline/understand.js";
import { JUDGE_MAX_TOKENS, JUDGE_PROMPT_VERSION, judgeSummary, loadJudgeConfig } from "./judge.js";
import { BudgetExceeded, estimateTokens, type Budget, type PlannedCall } from "./lib/cost.js";
import { sha256File } from "./lib/hash.js";
import { readJsonl } from "./lib/jsonl.js";
import { PATHS, REPO_ROOT } from "./lib/paths.js";
import {
  callWithBudget,
  parseRunOptions,
  runPaidJobs,
  ttyConfirm,
  type Confirm,
  type RunReport,
} from "./lib/run-guard.js";
import type { JudgeResult, OutputLine } from "./metrics/types.js";
import { writeReports } from "./report/index.js";
import type { DatasetRecord } from "./schema/dataset-record.schema.js";
import { readSmallSubset, SMALL_SUBSET_PATH } from "./subsets.js";

/** Planning estimates for the run guard; thinking is billed as output. */
const CLASSIFY_OUTPUT_ESTIMATE = 600;
const JUDGE_OUTPUT_ESTIMATE = 300;
const SUMMARY_TOKENS_ESTIMATE = 100;
export const EVAL_MAX_COST = 3;

export interface RunInfo {
  runId: string;
  set: "full" | "small";
  ids: string[];
  startedAt: string;
  finishedAt: string | null;
  /** False until every message is done; stays false for a run stopped early. */
  complete: boolean;
  classifier: { model: string; effort: string; promptVersion: string; promptSha256: string };
  judge: { model: string; effort: string; promptVersion: string; promptSha256: string };
  /** The masker the messages went through before any model call (P05); null in earlier runs. */
  masker?: { version: string } | null;
  dataset: { file: string; sha256: string };
  subset: { file: string; sha256: string } | null;
  git: { commit: string; dirty: boolean };
  options: { maxCost: number; concurrency: number };
  guard: Omit<RunReport, "script" | "dryRun" | "started" | "finished"> | null;
}

export interface EvalDeps {
  /** Created only for a real run; tests pass a mock. */
  createLlm?: () => LlmClient;
  env?: NodeJS.ProcessEnv;
  resultsDir?: string;
  datasetPath?: string;
  /** The CRM seed routing is scored against (P07); eval/data/crm/seed.json by default. */
  crmSeedPath?: string;
  clock?: () => Date;
  git?: () => { commit: string; dirty: boolean };
  confirm?: Confirm;
  log?: (line: string) => void;
}

function gitInfo(): { commit: string; dirty: boolean } {
  const run = (args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  return { commit: run(["rev-parse", "HEAD"]), dirty: run(["status", "--porcelain"]) !== "" };
}

export function makeRunId(at: Date, set: string, model: string, promptVersion: string): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${set}-${model}-${promptVersion}`;
}

/** An LlmClient that reserves the planned cost under the run's budget before every call. */
function budgeted(llm: LlmClient, budget: Budget, planned: PlannedCall): LlmClient {
  return { complete: (request: LlmRequest) => callWithBudget(llm, budget, request, planned) };
}

const registryHash = (version: string): string => {
  const registry = JSON.parse(readFileSync(PATHS.promptRegistry, "utf8")) as {
    prompts: Record<string, { sha256: string }>;
  };
  const hash = registry.prompts[version]?.sha256;
  if (!hash) throw new Error(`Prompt ${version} is not in src/llm/prompts/versions.json.`);
  return hash;
};

/** Returns the run folder, or null for a dry run or an unconfirmed run. */
export async function runEval(argv: string[], deps: EvalDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const clock = deps.clock ?? (() => new Date());
  const datasetPath = deps.datasetPath ?? PATHS.dataset;
  const resultsDir = deps.resultsDir ?? PATHS.results;

  // The eval's own cap default is $3 (P04 requirements.md); the P00 scripts keep theirs.
  const options = { ...parseRunOptions(argv), ...(argv.includes("--max-cost") ? {} : { maxCost: EVAL_MAX_COST }) };
  const subsetIndex = argv.indexOf("--subset");
  const subsetName = subsetIndex >= 0 ? argv[subsetIndex + 1] : undefined;
  if (subsetName !== undefined && subsetName !== "small")
    throw new Error(`Unknown subset "${subsetName}"; use "small".`);
  const set = subsetName === "small" ? "small" : "full";

  const classifier = loadClassifierConfig(env);
  const judgeConfig = loadJudgeConfig(env);
  if (!options.dryRun && !deps.createLlm && !env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error(
      "Missing ANTHROPIC_API_KEY. Set it in .env (see .env.example); an evaluation run calls paid models.",
    );
  }

  const dataset = readJsonl<DatasetRecord>(datasetPath);
  const ids = set === "small" ? readSmallSubset().ids : dataset.map((r) => r.id);
  const byId = new Map(dataset.map((r) => [r.id, r]));
  const records = [...ids].sort().map((id) => {
    const r = byId.get(id);
    if (!r?.final) throw new Error(`Message ${id} is missing or has no final labels.`);
    return r;
  });

  const classifyPrompt = loadPrompt(CLASSIFY_PROMPT_VERSION);
  const judgePrompt = loadPrompt(JUDGE_PROMPT_VERSION, PATHS.prompts);
  const started = clock();
  const runId = makeRunId(started, set, classifier.model, classifyPrompt.version);
  const runDir = join(resultsDir, runId);
  let llm: LlmClient | undefined;
  const getLlm = () => (llm ??= (deps.createLlm ?? createAnthropicClient)());

  const writeLine = (line: OutputLine) => appendFileSync(join(runDir, "outputs.jsonl"), JSON.stringify(line) + "\n");
  let prepared = false;
  const prepare = (info: RunInfo) => {
    if (prepared) return;
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify(info, null, 2) + "\n");
    writeFileSync(join(runDir, "outputs.jsonl"), "");
    prepared = true;
  };

  const info: RunInfo = {
    runId,
    set,
    ids: records.map((r) => r.id),
    startedAt: started.toISOString(),
    finishedAt: null,
    complete: false,
    classifier: {
      model: classifier.model,
      effort: classifier.effort,
      promptVersion: classifyPrompt.version,
      promptSha256: registryHash(classifyPrompt.version),
    },
    judge: {
      model: judgeConfig.model,
      effort: judgeConfig.effort,
      promptVersion: judgePrompt.version,
      promptSha256: registryHash(judgePrompt.version),
    },
    dataset: { file: relative(REPO_ROOT, datasetPath), sha256: sha256File(datasetPath) },
    masker: { version: MASKER_VERSION },
    subset:
      set === "small" ? { file: relative(REPO_ROOT, SMALL_SUBSET_PATH), sha256: sha256File(SMALL_SUBSET_PATH) } : null,
    git: (deps.git ?? gitInfo)(),
    options: { maxCost: options.maxCost, concurrency: options.concurrency },
    guard: null,
  };

  const jobs = records.map((record) => {
    // Masked in memory with the pipeline's masker: neither the classifier nor the judge sees
    // the raw text (P05). Message text and mapping are not written to the run folder.
    const masked = mask(record.text);
    const input = { maskedText: masked.maskedText, identifiers: masked.identifiers, channel: record.channel };
    const request = buildRequest(input, { ...classifier, prompt: classifyPrompt });
    const plannedClassify: PlannedCall = {
      model: classifier.model,
      inputTokens: estimateTokens(request.system + request.user),
      outputTokens: Math.min(CLASSIFY_OUTPUT_ESTIMATE, CLASSIFY_MAX_TOKENS),
    };
    const plannedJudge: PlannedCall = {
      model: judgeConfig.model,
      inputTokens: estimateTokens(judgePrompt.system + masked.maskedText) + SUMMARY_TOKENS_ESTIMATE,
      outputTokens: Math.min(JUDGE_OUTPUT_ESTIMATE, JUDGE_MAX_TOKENS),
    };
    return {
      id: record.id,
      planned: [plannedClassify, plannedJudge],
      run: async (budget: Budget): Promise<OutputLine> => {
        prepare(info);
        const attempt = await understand(input, {
          llm: budgeted(getLlm(), budget, plannedClassify),
          ...classifier,
          prompt: classifyPrompt,
        });
        let judge: JudgeResult | null = null;
        let stop: BudgetExceeded | null = null;
        if (attempt.outcome === "valid") {
          try {
            judge = await judgeSummary(
              { channel: record.channel, text: masked.maskedText, summary: attempt.classification!.summary },
              { llm: budgeted(getLlm(), budget, plannedJudge), ...judgeConfig, prompt: judgePrompt },
            );
          } catch (error) {
            if (!(error instanceof BudgetExceeded)) throw error;
            // The classification is paid for: keep it, mark the summary as not graded, then stop.
            stop = error;
            judge = {
              outcome: "error",
              scores: null,
              rawOutput: null,
              errors: ["not graded: budget cap reached"],
              promptVersion: judgePrompt.version,
              model: judgeConfig.model,
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
              costUsd: 0,
              latencyMs: 0,
            };
          }
        }
        const line: OutputLine = { id: record.id, attempt, judge };
        writeLine(line);
        if (stop) throw stop;
        return line;
      },
    };
  });

  const report = await runPaidJobs(`eval (${set})`, jobs, options, deps.confirm ?? ttyConfirm, log);
  if (report.dryRun) return null;
  prepare(info); // a run stopped before its first message still gets its folder

  // Lines were appended as messages finished; store them in ID order.
  const lines = readJsonl<OutputLine>(join(runDir, "outputs.jsonl")).sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(
    join(runDir, "outputs.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""),
  );
  const { script: _s, dryRun: _d, started: _st, finished: _f, ...guard } = report;
  const finalInfo: RunInfo = {
    ...info,
    finishedAt: clock().toISOString(),
    complete: lines.length === records.length && !report.stoppedByBudget,
    guard,
  };
  writeFileSync(join(runDir, "run.json"), JSON.stringify(finalInfo, null, 2) + "\n");
  await writeReports(runDir, { datasetPath, crmSeedPath: deps.crmSeedPath, log });
  log(`Run folder: ${relative(process.cwd(), runDir)}`);
  // In GitHub Actions (P12), later steps read the run from the step's outputs instead of
  // guessing the newest folder.
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `run-id=${info.runId}\nrun-dir=${runDir}\n`);
  return runDir;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runEval(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
