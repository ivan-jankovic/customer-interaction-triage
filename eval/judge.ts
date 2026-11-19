// The summary judge (P04): grades a classification summary against its message with a
// different, cheaper model than the classifier, so the classifier doesn't grade itself.
// The judge never sees the labels. Fallbacks stay off: a judge result must come from the
// judge model. Like the classifier (P03 masking exception), it sees the raw synthetic text.

import { Ajv, type ErrorObject } from "ajv";
import type { FromSchema } from "json-schema-to-ts";
import { EFFORTS, type Effort, type LlmClient } from "../src/llm/client.js";
import { costOf, hasPrice } from "../src/llm/pricing.js";
import { render, type PromptTemplate } from "../src/llm/prompts.js";
import { escapeMessage } from "../src/pipeline/understand.js";
import type { Channel } from "../src/taxonomy.js";
import type { JudgeResult } from "./metrics/types.js";

export const JUDGE_PROMPT_VERSION = "summary-judge.v1";
export const JUDGE_MAX_TOKENS = 2000;

export const judgeSchema = {
  type: "object",
  properties: {
    faithful: { type: "integer", minimum: 1, maximum: 5 },
    complete: { type: "integer", minimum: 1, maximum: 5 },
    contains_personal_data: { type: "boolean" },
    reason: { type: "string", minLength: 1, maxLength: 300 },
  },
  required: ["faithful", "complete", "contains_personal_data", "reason"],
  additionalProperties: false,
} as const;
export type JudgeOutput = FromSchema<typeof judgeSchema>;

const validate = new Ajv({ allErrors: true, strict: true }).compile<JudgeOutput>(judgeSchema);
const formatErrors = (errors: ErrorObject[] | null | undefined) =>
  (errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);

export interface JudgeConfig {
  model: string;
  effort: Effort;
}

/** claude-haiku-5-5 at effort low unless EVAL_JUDGE_MODEL / EVAL_JUDGE_EFFORT say otherwise. */
export function loadJudgeConfig(env: NodeJS.ProcessEnv = process.env): JudgeConfig {
  const model = env.EVAL_JUDGE_MODEL?.trim() || "claude-haiku-5-5";
  const effort = env.EVAL_JUDGE_EFFORT?.trim() || "low";
  if (!hasPrice(model)) throw new Error(`EVAL_JUDGE_MODEL "${model}" has no price in src/llm/pricing.ts.`);
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`EVAL_JUDGE_EFFORT must be one of ${EFFORTS.join(", ")}, got "${effort}".`);
  }
  return { model, effort: effort as Effort };
}

export interface JudgeInput {
  channel: Channel;
  text: string;
  summary: string;
}

export interface JudgeDeps extends JudgeConfig {
  llm: LlmClient;
  prompt: PromptTemplate;
  now?: () => number;
}

export async function judgeSummary(input: JudgeInput, deps: JudgeDeps): Promise<JudgeResult> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  const result = await deps.llm.complete({
    model: deps.model,
    effort: deps.effort,
    system: deps.prompt.system,
    user: render(deps.prompt.user, {
      channel: input.channel,
      message: escapeMessage(input.text),
      summary: escapeMessage(input.summary),
    }),
    schema: judgeSchema,
    maxTokens: JUDGE_MAX_TOKENS,
  });
  const latencyMs = Math.round(now() - started);
  const base = { promptVersion: deps.prompt.version, model: result.model, usage: result.usage, latencyMs };
  const costUsd = costOf(result.model, result.usage);

  if (!result.ok) {
    const outcome = result.failure === "api_error" ? "error" : "invalid";
    return { ...base, costUsd, outcome, scores: null, rawOutput: result.text ?? null, errors: [result.error] };
  }
  let data: unknown;
  try {
    data = JSON.parse(result.text);
  } catch {
    return { ...base, costUsd, outcome: "invalid", scores: null, rawOutput: result.text, errors: ["not valid JSON"] };
  }
  if (!validate(data)) {
    return {
      ...base,
      costUsd,
      outcome: "invalid",
      scores: null,
      rawOutput: result.text,
      errors: formatErrors(validate.errors),
    };
  }
  return { ...base, costUsd, outcome: "graded", scores: data, rawOutput: result.text, errors: [] };
}
