// Step 3 of the dataset procedure: two different models label every dataset message
// independently, using only the labelling guide. Neither sees the chosen labels or the
// other grader's answer (separate calls, separate prompts with no shared state).
// Output is validated with Ajv; an invalid answer is retried once, then recorded as
// invalid, which sends the message to human review. Injection messages are not graded:
// they are reviewed by hand in full.
//
// Usage: npm run dataset:grade -- [--dry-run] [--yes] [--max-cost 10] [--only msg-001]
// Needs ANTHROPIC_API_KEY (paid). Run --dry-run first.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Budget } from "../lib/cost.js";
import { estimateTokens, type PlannedCall } from "../lib/cost.js";
import { appendJsonl, readJsonl } from "../lib/jsonl.js";
import { createAnthropicClient, type LlmClient, type LlmRequest } from "../lib/llm.js";
import { PATHS } from "../lib/paths.js";
import { loadPrompt, render, type PromptTemplate } from "../lib/prompts.js";
import { callWithBudget, logRun, parseRunOptions, runPaidJobs, type Job } from "../lib/run-guard.js";
import { graderOutputSchema, type GraderOutput } from "../schema/labels.schema.js";
import { formatAjvErrors, validateGraderOutputSchema } from "../schema/validate.js";
import { latestGenerated, type GeneratedEntry } from "./generate.js";
import type { PlanEntry } from "./plan.js";

export const GRADE_PROMPT_VERSION = "grade.v1";
export const GRADERS = {
  a: process.env.DATASET_GRADER_A_MODEL ?? "claude-sonnet-5-5",
  b: process.env.DATASET_GRADER_B_MODEL ?? "claude-haiku-5-5",
} as const;
export type GraderSlot = keyof typeof GRADERS;

const MAX_TOKENS = 8000;
const PLANNED_OUTPUT_TOKENS = 1200;

export interface GradedEntry {
  id: string;
  /** The generation attempt that was graded; a rewrite needs grading again. */
  attempt: number;
  grader: GraderSlot;
  model: string;
  prompt_version: string;
  valid: boolean;
  output: GraderOutput | null;
  error: string | null;
  graded_at: string;
}

export function buildGradeRequest(text: string, channel: string, prompt: PromptTemplate, guide: string, model: string): LlmRequest {
  return {
    model,
    system: render(prompt.system, { labelling_guide: guide }),
    user: render(prompt.user, { channel, text }),
    schema: graderOutputSchema,
    maxTokens: MAX_TOKENS,
    effort: "medium",
  };
}

export function plannedGradeCall(request: LlmRequest): PlannedCall {
  return { model: request.model, inputTokens: estimateTokens(request.system + request.user), outputTokens: PLANNED_OUTPUT_TOKENS };
}

/** One grader's answer for one message: one call, plus one retry if the output is invalid. */
export async function gradeOne(
  client: LlmClient,
  budget: Budget,
  id: string,
  attempt: number,
  grader: GraderSlot,
  request: LlmRequest,
): Promise<GradedEntry> {
  let error = "no attempt made";
  for (let tryNo = 1; tryNo <= 2; tryNo++) {
    const result = await callWithBudget(client, budget, request, plannedGradeCall(request));
    if (!result.ok) {
      error = result.error;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      error = "output is not valid JSON";
      continue;
    }
    if (!validateGraderOutputSchema(parsed)) {
      error = `schema: ${formatAjvErrors(validateGraderOutputSchema.errors).join("; ")}`;
      continue;
    }
    return { id, attempt, grader, model: request.model, prompt_version: GRADE_PROMPT_VERSION, valid: true, output: parsed, error: null, graded_at: new Date().toISOString() };
  }
  return { id, attempt, grader, model: request.model, prompt_version: GRADE_PROMPT_VERSION, valid: false, output: null, error, graded_at: new Date().toISOString() };
}

/** Latest grading per (id, attempt, grader). */
export function latestGraded(rows: readonly GradedEntry[]): Map<string, GradedEntry> {
  const map = new Map<string, GradedEntry>();
  for (const row of rows) map.set(`${row.id}#${row.attempt}#${row.grader}`, row);
  return map;
}

async function main(): Promise<void> {
  const options = parseRunOptions(process.argv.slice(2));
  const plan = readJsonl<PlanEntry>(PATHS.plan).filter((e) => e.id.startsWith("msg-"));
  const generated = latestGenerated(readJsonl<GeneratedEntry>(PATHS.generated));
  const graded = latestGraded(readJsonl<GradedEntry>(PATHS.graded));
  const prompt = loadPrompt(GRADE_PROMPT_VERSION);
  const guide = readFileSync(PATHS.guide, "utf8");
  const client: LlmClient = options.dryRun ? { complete: () => Promise.reject(new Error("dry run")) } : createAnthropicClient();

  const jobs: Job<GradedEntry[]>[] = [];
  let missing = 0;
  for (const entry of plan) {
    const gen = generated.get(entry.id);
    if (!gen?.ok || gen.text === null) {
      missing++;
      continue;
    }
    if (options.only && !options.only.has(entry.id)) continue;
    const slots = (Object.keys(GRADERS) as GraderSlot[]).filter((g) => options.only || !graded.has(`${entry.id}#${gen.attempt}#${g}`));
    if (slots.length === 0) continue;
    const requests = slots.map((g) => ({ g, req: buildGradeRequest(gen.text!, entry.channel, prompt, guide, GRADERS[g]) }));
    jobs.push({
      id: entry.id,
      planned: requests.map((r) => plannedGradeCall(r.req)),
      run: async (budget) => {
        const out: GradedEntry[] = [];
        for (const { g, req } of requests) out.push(await gradeOne(client, budget, entry.id, gen.attempt, g, req));
        return out;
      },
    });
  }
  if (missing) console.log(`Note: ${missing} dataset entries have no successful generation yet and are skipped.`);

  let invalid = 0;
  const report = await runPaidJobs("dataset:grade", jobs, options, undefined, console.log, (_id, results) => {
    for (const r of results) {
      appendJsonl(PATHS.graded, r);
      if (!r.valid) invalid++;
    }
  });
  logRun({ ...report, note: `prompt ${GRADE_PROMPT_VERSION}, graders ${GRADERS.a} + ${GRADERS.b}` });
  if (invalid) console.log(`${invalid} grader answers were invalid after a retry; those messages go to review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
