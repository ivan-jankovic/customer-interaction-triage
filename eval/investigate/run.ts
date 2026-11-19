// npm run eval:investigate [-- --from <run-id | dir>] [--subset small] [--dry-run] [--yes]
//                          [--max-cost 2] [--concurrency 4]
//
// Runs the investigating agent (P10) over the dataset's labelled technical faults and writes a
// run folder in eval/results/, scored against the causes designed into the CRM seed. The input
// is a classify run's stored classifications (by default the kept classify.v2 run), so only the
// agent is paid for: each fault is masked and enriched against the in-memory seed CRM, as the
// routing metrics do, and the tools read that CRM too. No database.
//
// Paid: the run guard prints an estimate and asks first (or takes --yes), and every model turn
// reserves its estimate under the --max-cost cap. A fault whose next turn would pass the cap
// is stopped and not written; the run is then marked incomplete.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { loadInvestigatorConfig } from "../../src/config.js";
import { CRM_SEED_PATH, readCrmSeed } from "../../src/db/crm-seed.js";
import {
  createAnthropicClient,
  type ConverseClient,
  type ConverseRequest,
  type ConverseResult,
} from "../../src/llm/client.js";
import { loadPrompt } from "../../src/llm/prompts.js";
import { TOOL_DEFINITIONS } from "../../src/llm/schemas/investigation.schema.js";
import { memoryCrm } from "../../src/pipeline/crm-memory.js";
import { enrich, ENRICHER_VERSION } from "../../src/pipeline/enrich.js";
import {
  buildFirstMessage,
  INVESTIGATE_MAX_TOKENS,
  INVESTIGATE_MAX_TURNS,
  INVESTIGATE_PROMPT_VERSION,
  INVESTIGATOR_VERSION,
  investigate,
  type InvestigateInput,
} from "../../src/pipeline/investigate.js";
import { mask, MASKER_VERSION } from "../../src/pipeline/mask.js";
import { Budget, estimateCost, estimateTokens, type PlannedCall } from "../lib/cost.js";
import { sha256File } from "../lib/hash.js";
import { readJsonl } from "../lib/jsonl.js";
import { PATHS, REPO_ROOT } from "../lib/paths.js";
import { parseRunOptions, runPaidJobs, ttyConfirm, type Confirm } from "../lib/run-guard.js";
import type { OutputLine } from "../metrics/types.js";
import { resolveRunDir } from "../report/cli.js";
import { makeRunId, type RunInfo } from "../run.js";
import type { DatasetRecord } from "../schema/dataset-record.schema.js";
import { readSmallSubset } from "../subsets.js";
import type { InvestigationOutputLine } from "./metrics.js";
import { writeInvestigationReports, type InvestigationRunInfo } from "./report.js";

/** The kept classify.v2 run (P05): the default input. */
export const DEFAULT_INPUT_RUN = "20261119-010458-full-claude-opus-5-5-classify.v2";
export const INVESTIGATE_EVAL_MAX_COST = 2;
/** Planning estimates per fault: turns, output per turn (thinking included), context growth per turn. */
const TURNS_ESTIMATE = 3;
const OUTPUT_PER_TURN_ESTIMATE = 600;
const CONTEXT_GROWTH_PER_TURN = 900;

export interface InvestigateEvalDeps {
  createLlm?: () => ConverseClient;
  env?: NodeJS.ProcessEnv;
  resultsDir?: string;
  datasetPath?: string;
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

const registryHash = (version: string): string => {
  const registry = JSON.parse(readFileSync(PATHS.promptRegistry, "utf8")) as {
    prompts: Record<string, { sha256: string }>;
  };
  const hash = registry.prompts[version]?.sha256;
  if (!hash) throw new Error(`Prompt ${version} is not in src/llm/prompts/versions.json.`);
  return hash;
};

/** A ConverseClient that reserves each turn's planned cost under the run's budget first. */
function budgeted(llm: ConverseClient, budget: Budget, planned: (turn: number) => PlannedCall): ConverseClient {
  let turn = 0;
  return {
    async converse(request: ConverseRequest): Promise<ConverseResult> {
      const p = planned(turn++);
      const estimate = estimateCost([p]);
      budget.reserve(estimate);
      let usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      try {
        const result = await llm.converse(request);
        usage = !result.ok && result.failure === "api_error" ? usage : result.usage;
        return result;
      } finally {
        budget.settle(estimate, request.model, usage);
      }
    },
  };
}

const value = (argv: readonly string[], flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Returns the run folder, or null for a dry run or an unconfirmed run. */
export async function runInvestigateEval(argv: string[], deps: InvestigateEvalDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const clock = deps.clock ?? (() => new Date());
  const datasetPath = deps.datasetPath ?? PATHS.dataset;
  const seedPath = deps.crmSeedPath ?? CRM_SEED_PATH;
  const resultsDir = deps.resultsDir ?? PATHS.results;

  const options = {
    ...parseRunOptions(argv),
    ...(argv.includes("--max-cost") ? {} : { maxCost: INVESTIGATE_EVAL_MAX_COST }),
  };
  const subsetName = value(argv, "--subset");
  if (subsetName !== undefined && subsetName !== "small")
    throw new Error(`Unknown subset "${subsetName}"; use "small".`);
  const set = subsetName === "small" ? "small" : "full";
  const config = loadInvestigatorConfig(env);
  if (!options.dryRun && !deps.createLlm && !env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error(
      "Missing ANTHROPIC_API_KEY. Set it in .env (see .env.example); an evaluation run calls a paid model.",
    );
  }

  const inputDir = resolveRunDir(value(argv, "--from") ?? DEFAULT_INPUT_RUN, resultsDir);
  const inputRun = JSON.parse(readFileSync(join(inputDir, "run.json"), "utf8")) as RunInfo;
  const inputs = new Map(readJsonl<OutputLine>(join(inputDir, "outputs.jsonl")).map((l) => [l.id, l.attempt]));

  const seed = readCrmSeed(seedPath);
  const crm = memoryCrm(seed);
  const dataset = new Map(readJsonl<DatasetRecord>(datasetPath).map((r) => [r.id, r]));
  const small = set === "small" ? new Set(readSmallSubset().ids) : null;
  const faults = seed.messages
    .filter((m) => m.expected_cause !== null && (!small || small.has(m.message_id)))
    .sort((a, b) => a.message_id.localeCompare(b.message_id));

  const prompt = loadPrompt(INVESTIGATE_PROMPT_VERSION);
  const started = clock();
  const runId = makeRunId(started, `investigate-${set}`, config.model, prompt.version);
  const runDir = join(resultsDir, runId);
  let llm: ConverseClient | undefined;
  const getLlm = () => (llm ??= (deps.createLlm ?? createAnthropicClient)());

  const info: InvestigationRunInfo = {
    kind: "investigate",
    runId,
    set,
    ids: faults.map((m) => m.message_id),
    startedAt: started.toISOString(),
    finishedAt: null,
    complete: false,
    investigator: {
      model: config.model,
      effort: config.effort,
      promptVersion: prompt.version,
      promptSha256: registryHash(prompt.version),
      investigatorVersion: INVESTIGATOR_VERSION,
      maxTurns: INVESTIGATE_MAX_TURNS,
    },
    input: {
      runId: inputRun.runId,
      dir: relative(REPO_ROOT, inputDir),
      classifierPromptVersion: inputRun.classifier.promptVersion,
    },
    masker: { version: MASKER_VERSION },
    enricherVersion: ENRICHER_VERSION,
    seed: { file: relative(REPO_ROOT, seedPath), sha256: sha256File(seedPath) },
    dataset: { file: relative(REPO_ROOT, datasetPath), sha256: sha256File(datasetPath) },
    git: (deps.git ?? gitInfo)(),
    options: { maxCost: options.maxCost, concurrency: options.concurrency },
    guard: null,
  };

  let prepared = false;
  const prepare = () => {
    if (prepared) return;
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify(info, null, 2) + "\n");
    writeFileSync(join(runDir, "outputs.jsonl"), "");
    prepared = true;
  };
  const writeLine = (line: InvestigationOutputLine) =>
    appendFileSync(join(runDir, "outputs.jsonl"), JSON.stringify(line) + "\n");

  const notInvestigated: InvestigationOutputLine[] = [];
  const jobs = [];
  for (const m of faults) {
    const record = dataset.get(m.message_id);
    const attempt = inputs.get(m.message_id);
    const c = attempt?.outcome === "valid" ? attempt.classification : null;
    if (!record || !c || c.intent !== "technical_fault") {
      notInvestigated.push({
        id: m.message_id,
        notInvestigated: !attempt
          ? "not in the input run"
          : !c
            ? `classification ${attempt.outcome}`
            : `classified as ${c.intent}`,
        attempt: null,
      });
      continue;
    }
    // Masked in memory, as in the pipeline: the agent never sees the raw text (P05).
    const masked = mask(record.text);
    const receivedAt = new Date(m.received_at);
    const enrichment = await enrich(
      { identifiers: masked.identifiers, area: c.fields.area, serviceType: c.fields.service_type, receivedAt },
      crm,
    );
    const input: InvestigateInput = {
      maskedText: masked.maskedText,
      channel: record.channel,
      receivedAt,
      classification: { serviceType: c.fields.service_type, area: c.fields.area, summary: c.summary },
      enrichment: {
        outcome: enrichment.outcome,
        customerId: enrichment.customerId,
        candidateIds: enrichment.candidates.map((x) => x.customerId),
        area: enrichment.area,
        areaSource: enrichment.areaSource,
      },
    };
    const firstTokens = estimateTokens(
      prompt.system + buildFirstMessage(input, prompt) + JSON.stringify(TOOL_DEFINITIONS),
    );
    const planned = (turn: number): PlannedCall => ({
      model: config.model,
      inputTokens: firstTokens + turn * CONTEXT_GROWTH_PER_TURN,
      outputTokens: Math.min(OUTPUT_PER_TURN_ESTIMATE, INVESTIGATE_MAX_TOKENS),
    });
    jobs.push({
      id: m.message_id,
      planned: Array.from({ length: TURNS_ESTIMATE }, (_, t) => planned(t)),
      run: async (budget: Budget): Promise<InvestigationOutputLine> => {
        prepare();
        const result = await investigate(input, {
          llm: budgeted(getLlm(), budget, planned),
          crm,
          model: config.model,
          effort: config.effort,
          prompt,
        });
        const line: InvestigationOutputLine = { id: m.message_id, notInvestigated: null, attempt: result };
        writeLine(line);
        return line;
      },
    });
  }
  if (notInvestigated.length > 0) {
    log(
      `Not investigated (${notInvestigated.length}): ${notInvestigated.map((l) => `${l.id} (${l.notInvestigated})`).join(", ")}`,
    );
  }

  const report = await runPaidJobs(`eval:investigate (${set})`, jobs, options, deps.confirm ?? ttyConfirm, log);
  if (report.dryRun) return null;
  prepare();
  for (const line of notInvestigated) writeLine(line);

  const lines = readJsonl<InvestigationOutputLine>(join(runDir, "outputs.jsonl")).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  writeFileSync(
    join(runDir, "outputs.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""),
  );
  const { script: _s, dryRun: _d, started: _st, finished: _f, ...guard } = report;
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify(
      {
        ...info,
        finishedAt: clock().toISOString(),
        complete: lines.length === faults.length && !report.stoppedByBudget,
        guard,
      } satisfies InvestigationRunInfo,
      null,
      2,
    ) + "\n",
  );
  writeInvestigationReports(runDir, { datasetPath, crmSeedPath: seedPath, log });
  log(`Run folder: ${relative(process.cwd(), runDir)}`);
  return runDir;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runInvestigateEval(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
