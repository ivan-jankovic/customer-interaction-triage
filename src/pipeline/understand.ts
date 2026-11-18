// Step 3 of the pipeline: one model call with structured output (P03). The result is an
// attempt that is always returned, never thrown: valid, invalid (no usable output) or error
// (the API call failed). Every attempt is stored (src/db/classifications.ts), so invalid
// output is visible in the audit trail and, from P07, sends the case to review.
//
// Masking exception: until P05 the text passed in is the raw message. That is allowed only
// because all data is synthetic (P03 requirements.md, "Masking before P05"); P05 passes the
// masked text instead, and nothing here changes.

import { Ajv, type ErrorObject } from "ajv";
import type { Effort, LlmClient, LlmRequest, LlmUsage } from "../llm/client.js";
import { ZERO_USAGE } from "../llm/client.js";
import { costOf } from "../llm/pricing.js";
import { render, type PromptTemplate } from "../llm/prompts.js";
import { classificationSchema, type Classification } from "../llm/schemas/classification.schema.js";
import type { Channel } from "../taxonomy.js";

export const CLASSIFY_PROMPT_VERSION = "classify.v1";
/** Thinking counts towards the limit; the answer itself is a few hundred tokens. */
export const CLASSIFY_MAX_TOKENS = 4000;

export const OUTCOMES = ["valid", "invalid", "error"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface ClassificationAttempt {
  outcome: Outcome;
  /** Set exactly when the outcome is valid. */
  classification: Classification | null;
  /** The model's text as returned, also when it is invalid; null when there was none. */
  rawOutput: string | null;
  /** Validation errors, the refusal or the API error; empty when valid. */
  errors: string[];
  promptVersion: string;
  requestedModel: string;
  servedModel: string;
  fellBack: boolean;
  effort: Effort;
  usage: LlmUsage;
  /** null when the served model has no known price (e.g. after a fallback). */
  costUsd: number | null;
  latencyMs: number;
}

export interface UnderstandInput {
  text: string;
  channel: Channel;
}

export interface UnderstandDeps {
  llm: LlmClient;
  model: string;
  effort: Effort;
  prompt: PromptTemplate;
  /** Milliseconds clock; injectable for tests. */
  now?: () => number;
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validateClassification = ajv.compile<Classification>(classificationSchema);

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => {
    const extra = e.keyword === "additionalProperties" ? ` '${String(e.params.additionalProperty)}'` : "";
    return `${e.instancePath || "/"} ${e.message ?? "is invalid"}${extra}`;
  });
}

/**
 * The message goes inside <customer_message> tags. Escaping < and > means nothing in the
 * message can close the tag or open a new one that looks like part of the prompt.
 */
export function escapeMessage(text: string): string {
  return text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function buildRequest(
  input: UnderstandInput,
  deps: Pick<UnderstandDeps, "model" | "effort" | "prompt">,
): LlmRequest {
  return {
    model: deps.model,
    effort: deps.effort,
    system: deps.prompt.system,
    user: render(deps.prompt.user, { channel: input.channel, message: escapeMessage(input.text) }),
    schema: classificationSchema,
    maxTokens: CLASSIFY_MAX_TOKENS,
    fallbacks: true,
  };
}

/** Parses and validates the model's text. */
export function parseClassification(
  text: string,
): { ok: true; classification: Classification } | { ok: false; errors: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!validateClassification(data)) return { ok: false, errors: formatErrors(validateClassification.errors) };
  return { ok: true, classification: data };
}

export async function understand(input: UnderstandInput, deps: UnderstandDeps): Promise<ClassificationAttempt> {
  const now = deps.now ?? (() => performance.now());
  const request = buildRequest(input, deps);
  const base = {
    promptVersion: deps.prompt.version,
    requestedModel: deps.model,
    effort: deps.effort,
  };

  const started = now();
  const result = await deps.llm.complete(request);
  const latencyMs = Math.round(now() - started);

  // A failed API call is billed nothing, whatever the client reports.
  const usage = !result.ok && result.failure === "api_error" ? ZERO_USAGE : result.usage;
  const served = {
    servedModel: result.model,
    fellBack: result.fellBack ?? false,
    usage,
    costUsd: costOf(result.model, usage),
    latencyMs,
  };

  if (!result.ok) {
    return {
      ...base,
      ...served,
      outcome: result.failure === "api_error" ? "error" : "invalid",
      classification: null,
      rawOutput: result.text ?? null,
      errors: [result.error],
    };
  }

  const parsed = parseClassification(result.text);
  if (!parsed.ok) {
    return {
      ...base,
      ...served,
      outcome: "invalid",
      classification: null,
      rawOutput: result.text,
      errors: parsed.errors,
    };
  }
  return {
    ...base,
    ...served,
    outcome: "valid",
    classification: parsed.classification,
    rawOutput: result.text,
    errors: [],
  };
}
