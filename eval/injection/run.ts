// npm run eval:injection [-- --repeat 5] [--dry-run] [--yes] [--max-cost 3] [--concurrency 4]
//
// Runs the injection set (P11) through the whole pipeline without a database: mask, classify
// (classify.v2), enrich against the in-memory CRM seed, investigate valid technical faults (the
// tools read the same seed), then grade the summary with the judge. Each message runs --repeat
// times (default 1), because model output varies and one clean pass proves little. Routing and
// the pass rule are computed from the stored outputs (eval/injection/metrics.ts), so
// `npm run eval:report` can rescore the run without a model.
//
// Paid: the run guard prints an estimate and asks first (or takes --yes), and every model call
// reserves its estimate under the --max-cost cap. A repeat whose next call would pass the cap
// is stopped and not written; the run is then marked incomplete.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { loadClassifierConfig, loadInvestigatorConfig } from "../../src/config.js";
import { CRM_SEED_PATH, readCrmSeed } from "../../src/db/crm-seed.js";
import {
  createAnthropicClient,
  type ConverseClient,
  type ConverseRequest,
  type ConverseResult,
  type LlmClient,
  type LlmRequest,
} from "../../src/llm/client.js";
import { loadPrompt } from "../../src/llm/prompts.js";
import { TOOL_DEFINITIONS } from "../../src/llm/schemas/investigation.schema.js";
import { memoryCrm } from "../../src/pipeline/crm-memory.js";
import { enrich, ENRICHER_VERSION } from "../../src/pipeline/enrich.js";
import {
  INVESTIGATE_MAX_TOKENS,
  INVESTIGATE_PROMPT_VERSION,
  INVESTIGATOR_VERSION,
  investigate,
  type InvestigateInput,
} from "../../src/pipeline/investigate.js";
import { mask, MASKER_VERSION } from "../../src/pipeline/mask.js";
import { ROUTER_VERSION } from "../../src/pipeline/route.js";
import {
  buildRequest,
  CLASSIFY_MAX_TOKENS,
  CLASSIFY_PROMPT_VERSION,
  understand,
} from "../../src/pipeline/understand.js";
import { JUDGE_MAX_TOKENS, JUDGE_PROMPT_VERSION, judgeSummary, loadJudgeConfig } from "../judge.js";
import { Budget, estimateCost, estimateTokens, type PlannedCall } from "../lib/cost.js";
import { sha256File } from "../lib/hash.js";
import { readJsonl } from "../lib/jsonl.js";
import { PATHS, REPO_ROOT } from "../lib/paths.js";
import { callWithBudget, parseRunOptions, runPaidJobs, ttyConfirm, type Confirm } from "../lib/run-guard.js";
import { makeRunId } from "../run.js";
import type { DatasetRecord } from "../schema/dataset-record.schema.js";
import { writeInjectionReports, type InjectionRunInfo } from "./report.js";
import type { InjectionOutputLine } from "./score.js";

export const INJECTION_EVAL_MAX_COST = 3;
/** Planning estimates; thinking is billed as output. */
const CLASSIFY_OUTPUT_ESTIMATE = 600;
const JUDGE_OUTPUT_ESTIMATE = 300;
const SUMMARY_TOKENS_ESTIMATE = 100;
const AGENT_TURNS_ESTIMATE = 3;
const AGENT_OUTPUT_PER_TURN_ESTIMATE = 600;
const AGENT_CONTEXT_GROWTH_PER_TURN = 900;

export type InjectionLlm = LlmClient & ConverseClient;

export interface InjectionEvalDeps {
  createLlm?: () => InjectionLlm;
  env?: NodeJS.ProcessEnv;
  resultsDir?: string;
  injectionPath?: string;
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

const budgetedComplete = (llm: LlmClient, budget: Budget, planned: PlannedCall): LlmClient => ({
  complete: (request: LlmRequest) => callWithBudget(llm, budget, request, planned),
});

function budgetedConverse(llm: ConverseClient, budget: Budget, planned: (turn: number) => PlannedCall): ConverseClient {
  let turn = 0;
  return {
    async converse(request: ConverseRequest): Promise<ConverseResult> {
      const estimate = estimateCost([planned(turn++)]);
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

export function parseRepeat(argv: readonly string[]): number {
  const i = argv.indexOf("--repeat");
  if (i < 0) return 1;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("--repeat must be a whole number from 1 to 20");
  return n;
}

/** Returns the run folder, or null for a dry run or an unconfirmed run. */
export async function runInjectionEval(argv: string[], deps: InjectionEvalDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const clock = deps.clock ?? (() => new Date());
  const injectionPath = deps.injectionPath ?? PATHS.injection;
  const seedPath = deps.crmSeedPath ?? CRM_SEED_PATH;
  const resultsDir = deps.resultsDir ?? PATHS.results;

  const options = {
    ...parseRunOptions(argv),
    ...(argv.includes("--max-cost") ? {} : { maxCost: INJECTION_EVAL_MAX_COST }),
  };
  const repeats = parseRepeat(argv);
  const classifier = loadClassifierConfig(env);
  const investigator = loadInvestigatorConfig(env);
  const judgeConfig = loadJudgeConfig(env);
  if (!options.dryRun && !deps.createLlm && !env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error(
      "Missing ANTHROPIC_API_KEY. Set it in .env (see .env.example); an evaluation run calls paid models.",
    );
  }

  const records = readJsonl<DatasetRecord>(injectionPath).sort((a, b) => a.id.localeCompare(b.id));
  const seed = readCrmSeed(seedPath);
  const crm = memoryCrm(seed);
  const receivedAt = new Map(seed.injection.map((m) => [m.message_id, new Date(m.received_at)]));

  const classifyPrompt = loadPrompt(CLASSIFY_PROMPT_VERSION);
  const investigatePrompt = loadPrompt(INVESTIGATE_PROMPT_VERSION);
  const judgePrompt = loadPrompt(JUDGE_PROMPT_VERSION, PATHS.prompts);
  const started = clock();
  const runId = makeRunId(started, `injection-x${repeats}`, classifier.model, classifyPrompt.version);
  const runDir = join(resultsDir, runId);
  let llm: InjectionLlm | undefined;
  const getLlm = () => (llm ??= (deps.createLlm ?? createAnthropicClient)());

  const info: InjectionRunInfo = {
    kind: "injection",
    runId,
    ids: records.map((r) => r.id),
    repeats,
    startedAt: started.toISOString(),
    finishedAt: null,
    complete: false,
    classifier: {
      model: classifier.model,
      effort: classifier.effort,
      promptVersion: classifyPrompt.version,
      promptSha256: registryHash(classifyPrompt.version),
    },
    investigator: {
      model: investigator.model,
      effort: investigator.effort,
      promptVersion: investigatePrompt.version,
      promptSha256: registryHash(investigatePrompt.version),
      investigatorVersion: INVESTIGATOR_VERSION,
    },
    judge: {
      model: judgeConfig.model,
      effort: judgeConfig.effort,
      promptVersion: judgePrompt.version,
      promptSha256: registryHash(judgePrompt.version),
    },
    masker: { version: MASKER_VERSION },
    enricherVersion: ENRICHER_VERSION,
    routerVersion: ROUTER_VERSION,
    seed: { file: relative(REPO_ROOT, seedPath), sha256: sha256File(seedPath) },
    injectionSet: { file: relative(REPO_ROOT, injectionPath), sha256: sha256File(injectionPath) },
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
  const writeLine = (line: InjectionOutputLine) =>
    appendFileSync(join(runDir, "outputs.jsonl"), JSON.stringify(line) + "\n");

  const jobs = records.flatMap((record) => {
    const at = receivedAt.get(record.id);
    if (!at) throw new Error(`${record.id} has no entry in the CRM seed's injection list; run npm run crm:generate.`);
    // Masked in memory, as in the pipeline: no model sees the raw text (P05).
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
    const agentFirstTokens = estimateTokens(
      investigatePrompt.system + investigatePrompt.user + masked.maskedText + JSON.stringify(TOOL_DEFINITIONS),
    );
    const plannedTurn = (turn: number): PlannedCall => ({
      model: investigator.model,
      inputTokens: agentFirstTokens + turn * AGENT_CONTEXT_GROWTH_PER_TURN,
      outputTokens: Math.min(AGENT_OUTPUT_PER_TURN_ESTIMATE, INVESTIGATE_MAX_TOKENS),
    });
    // The estimate plans the agent for the messages labelled technical_fault; at run time it
    // runs for whatever the classifier says is a valid technical fault.
    const labels = record.final ?? record.chosen;
    const plannedAgent =
      labels.intent === "technical_fault" ? Array.from({ length: AGENT_TURNS_ESTIMATE }, (_, t) => plannedTurn(t)) : [];

    return Array.from({ length: repeats }, (_, k) => ({
      id: `${record.id}#${k + 1}`,
      planned: [plannedClassify, ...plannedAgent, plannedJudge],
      run: async (budget: Budget): Promise<InjectionOutputLine> => {
        prepare();
        const attempt = await understand(input, {
          llm: budgetedComplete(getLlm(), budget, plannedClassify),
          ...classifier,
          prompt: classifyPrompt,
        });
        const c = attempt.outcome === "valid" ? attempt.classification : null;
        let investigation: InjectionOutputLine["investigation"] = null;
        if (c?.intent === "technical_fault") {
          const enrichment = await enrich(
            {
              identifiers: masked.identifiers,
              area: c.fields.area,
              serviceType: c.fields.service_type,
              receivedAt: at,
            },
            crm,
          );
          const agentInput: InvestigateInput = {
            maskedText: masked.maskedText,
            channel: record.channel,
            receivedAt: at,
            classification: { serviceType: c.fields.service_type, area: c.fields.area, summary: c.summary },
            enrichment: {
              outcome: enrichment.outcome,
              customerId: enrichment.customerId,
              candidateIds: enrichment.candidates.map((x) => x.customerId),
              area: enrichment.area,
              areaSource: enrichment.areaSource,
            },
          };
          investigation = await investigate(agentInput, {
            llm: budgetedConverse(getLlm(), budget, plannedTurn),
            crm,
            model: investigator.model,
            effort: investigator.effort,
            prompt: investigatePrompt,
          });
        }
        // One retry when the judge's own output is invalid (as the P00 graders do): the judge
        // measures the summary, and a malformed grade says nothing about the pipeline. Decided
        // during implementation after the first kept run (requirements.md, Implementation notes).
        const grade = () =>
          judgeSummary(
            { channel: record.channel, text: masked.maskedText, summary: c!.summary },
            { llm: budgetedComplete(getLlm(), budget, plannedJudge), ...judgeConfig, prompt: judgePrompt },
          );
        let judge = c ? await grade() : null;
        let judgeRetried: InjectionOutputLine["judgeRetried"] = null;
        if (judge?.outcome === "invalid") {
          judgeRetried = judge;
          judge = await grade();
        }
        const line: InjectionOutputLine = {
          id: record.id,
          repeat: k + 1,
          attempt,
          investigation,
          judge,
          judgeRetried,
        };
        writeLine(line);
        return line;
      },
    }));
  });

  const report = await runPaidJobs(`eval:injection (x${repeats})`, jobs, options, deps.confirm ?? ttyConfirm, log);
  if (report.dryRun) return null;
  prepare();

  const lines = readJsonl<InjectionOutputLine>(join(runDir, "outputs.jsonl")).sort(
    (a, b) => a.id.localeCompare(b.id) || a.repeat - b.repeat,
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
        complete: lines.length === records.length * repeats && !report.stoppedByBudget,
        guard,
      } satisfies InjectionRunInfo,
      null,
      2,
    ) + "\n",
  );
  const metrics = await writeInjectionReports(runDir, { injectionPath, crmSeedPath: seedPath, log });
  log(
    `Scenarios passed: ${metrics.overall.passed} / ${metrics.overall.scenarios}` +
      (metrics.flaky ? ` (${metrics.flaky} flaky)` : ""),
  );
  log(`Run folder: ${relative(process.cwd(), runDir)}`);
  return runDir;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runInjectionEval(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
