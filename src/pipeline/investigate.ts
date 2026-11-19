// Step 5 of the pipeline: the investigating agent (P10 requirements.md, "The agent"). The one
// agentic step: a hand-written loop (no framework) in which the model calls three read-only
// tools and ends with a structured answer, a likely cause with evidence. Like understand(), it
// always returns an attempt and never throws for model behaviour; every attempt is stored.
//
// Bounded: at most INVESTIGATE_MAX_TURNS model calls and MAX_TOOL_CALLS tool runs. A model
// that still asks for tools at the last turn ends with outcome `step_limit`.
//
// Untrusted input: the message is escaped inside <customer_message>; the tools only read, and
// only the case's own customers (the guard in investigate-tools.ts); the answer is validated,
// and its evidence must come from tools that answered. The agent never decides anything:
// routing reads the attempt (isInconclusive in route.ts) and can only add a review.

import { Ajv, type ErrorObject } from "ajv";
import type { ConverseClient, ConverseMessage, Effort, LlmUsage, UserContent } from "../llm/client.js";
import { ZERO_USAGE } from "../llm/client.js";
import { costOf } from "../llm/pricing.js";
import { render, type PromptTemplate } from "../llm/prompts.js";
import {
  investigationOutputSchema,
  TOOL_DEFINITIONS,
  type EvidenceItem,
  type InvestigationOutput,
} from "../llm/schemas/investigation.schema.js";
import type { StoredToolCall } from "../db/database.js";
import type { Channel, InvestigationOutcome, LikelyCause, ServiceType } from "../taxonomy.js";
import type { AreaSource, EnrichmentOutcome } from "./enrich.js";
import { runTool, type ToolContext } from "./investigate-tools.js";
import type { InvestigationCrm } from "./investigation-crm.js";
import { escapeMessage } from "./understand.js";

export const INVESTIGATOR_VERSION = "investigate.v1";
export const INVESTIGATE_PROMPT_VERSION = "investigate.v1";
/** Model turns per investigation: three tools, room to recover from a tool error, and the answer. */
export const INVESTIGATE_MAX_TURNS = 6;
/** Tool runs per investigation; calls beyond it get an error result and aren't run. */
export const MAX_TOOL_CALLS = 12;
/** Per turn; thinking counts towards it, and the answer itself is a few hundred tokens. */
export const INVESTIGATE_MAX_TOKENS = 8000;

export interface InvestigateInput {
  /** Masked text only (P05): the raw text never reaches this step. */
  maskedText: string;
  channel: Channel;
  /** The message's received_at: the "now" of every tool. */
  receivedAt: Date;
  classification: { serviceType: ServiceType; area: string | null; summary: string };
  enrichment: {
    outcome: EnrichmentOutcome;
    /** The found customer; null unless the outcome is `found`. */
    customerId: string | null;
    /** The ambiguous candidates' customer IDs; empty unless the outcome is `ambiguous`. */
    candidateIds: readonly string[];
    area: string | null;
    areaSource: AreaSource | null;
  };
}

export interface InvestigateDeps {
  llm: ConverseClient;
  crm: InvestigationCrm;
  model: string;
  effort: Effort;
  prompt: PromptTemplate;
  maxTurns?: number;
  /** Milliseconds clock; injectable for tests. */
  now?: () => number;
}

export interface InvestigationAttempt {
  outcome: InvestigationOutcome;
  /** likelyCause, confidence and summary are set exactly when the outcome is `valid`. */
  likelyCause: LikelyCause | null;
  confidence: number | null;
  summary: string | null;
  /** Empty unless the outcome is `valid`. */
  evidence: EvidenceItem[];
  /** Model turns taken. */
  steps: number;
  toolCalls: StoredToolCall[];
  /** The last turn's text; null when there was none. */
  rawOutput: string | null;
  errors: string[];
  promptVersion: string;
  requestedModel: string;
  servedModel: string;
  effort: Effort;
  /** Summed over turns. */
  usage: LlmUsage;
  costUsd: number | null;
  latencyMs: number;
  /** For an `error` outcome only: the HTTP status, or null for a connection error (P08 retries). */
  apiStatus?: number | null;
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validateOutput = ajv.compile<InvestigationOutput>(investigationOutputSchema);

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => {
    const extra = e.keyword === "additionalProperties" ? ` '${String(e.params.additionalProperty)}'` : "";
    return `${e.instancePath || "/"} ${e.message ?? "is invalid"}${extra}`;
  });
}

/** The customers the tools may look up: the found one, or the ambiguous candidates. */
export function allowedCustomerIds(enrichment: InvestigateInput["enrichment"]): string[] {
  if (enrichment.outcome === "found" && enrichment.customerId) return [enrichment.customerId];
  if (enrichment.outcome === "ambiguous") return [...enrichment.candidateIds];
  return [];
}

/** The <case> block: what code knows about the case. No identifier values, no outages. */
export function caseBlock(input: InvestigateInput): string {
  const e = input.enrichment;
  const ids = allowedCustomerIds(e);
  const lookup =
    e.outcome === "found"
      ? "found one customer"
      : e.outcome === "ambiguous"
        ? `ambiguous: the message's identifiers matched ${ids.length} customers`
        : e.outcome === "not_found"
          ? "no customer matched the message's identifiers"
          : "the message has no account identifiers";
  const lines = [
    `Message received at: ${input.receivedAt.toISOString()}`,
    `Service type (from the classification): ${input.classification.serviceType}`,
    `Area: ${e.area ? `${e.area} (from the ${e.areaSource === "customer" ? "customer's services" : "message"})` : "none known"}`,
    `Classification summary: ${input.classification.summary}`,
    `Customer lookup: ${lookup}`,
    `Customer IDs you may look up: ${ids.length > 0 ? ids.join(", ") : "none"}`,
  ];
  return escapeMessage(lines.join("\n"));
}

export function buildFirstMessage(input: InvestigateInput, prompt: PromptTemplate): string {
  return render(prompt.user, {
    case: caseBlock(input),
    channel: input.channel,
    message: escapeMessage(input.maskedText),
  });
}

const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
});

/**
 * Parses and checks the final answer: the schema, then what a schema can't say (P10
 * requirements.md, "The loop"): a cause needs evidence, and every evidence item must name a
 * tool that was called and answered without an error in this loop.
 */
export function parseAnswer(
  text: string,
  toolCalls: readonly StoredToolCall[],
): { ok: true; output: InvestigationOutput } | { ok: false; errors: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!validateOutput(data)) return { ok: false, errors: formatErrors(validateOutput.errors) };
  const errors: string[] = [];
  if (data.likely_cause !== "inconclusive" && data.evidence.length === 0) {
    errors.push(`/evidence is empty for likely cause ${data.likely_cause}`);
  }
  const answered = new Set(toolCalls.filter((c) => !c.is_error).map((c) => c.tool));
  data.evidence.forEach((item, i) => {
    if (!answered.has(item.tool)) errors.push(`/evidence/${i} cites ${item.tool}, which didn't answer in this loop`);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, output: data };
}

export async function investigate(input: InvestigateInput, deps: InvestigateDeps): Promise<InvestigationAttempt> {
  if (deps.prompt.version !== INVESTIGATE_PROMPT_VERSION) {
    throw new Error(`investigate() runs ${INVESTIGATE_PROMPT_VERSION}, got ${deps.prompt.version}.`);
  }
  const now = deps.now ?? (() => performance.now());
  const maxTurns = deps.maxTurns ?? INVESTIGATE_MAX_TURNS;
  const toolCtx: ToolContext = {
    crm: deps.crm,
    receivedAt: input.receivedAt,
    customerIds: allowedCustomerIds(input.enrichment),
  };
  const messages: ConverseMessage[] = [{ role: "user", content: buildFirstMessage(input, deps.prompt) }];
  const toolCalls: StoredToolCall[] = [];
  let usage: LlmUsage = ZERO_USAGE;
  let cost: number | null = 0;
  let servedModel = deps.model;
  let steps = 0;
  const started = now();

  const finish = (
    rest: Partial<InvestigationAttempt> & Pick<InvestigationAttempt, "outcome" | "rawOutput" | "errors">,
  ) => ({
    likelyCause: null,
    confidence: null,
    summary: null,
    evidence: [],
    steps,
    toolCalls,
    promptVersion: deps.prompt.version,
    requestedModel: deps.model,
    servedModel,
    effort: deps.effort,
    usage,
    costUsd: cost,
    latencyMs: Math.round(now() - started),
    ...rest,
  });

  for (let turn = 1; turn <= maxTurns; turn++) {
    steps = turn;
    const result = await deps.llm.converse({
      model: deps.model,
      system: deps.prompt.system,
      messages,
      tools: TOOL_DEFINITIONS,
      schema: investigationOutputSchema,
      maxTokens: INVESTIGATE_MAX_TOKENS,
      effort: deps.effort,
    });
    servedModel = result.model;
    // A failed API call is billed nothing, whatever the client reports.
    const turnUsage = !result.ok && result.failure === "api_error" ? ZERO_USAGE : result.usage;
    usage = addUsage(usage, turnUsage);
    const turnCost = costOf(result.model, turnUsage);
    cost = cost === null || turnCost === null ? null : cost + turnCost;

    if (!result.ok) {
      const apiError = result.failure === "api_error";
      return finish({
        outcome: apiError ? "error" : "invalid",
        rawOutput: result.text ?? null,
        errors: [result.error],
        ...(apiError ? { apiStatus: result.status ?? null } : {}),
      });
    }

    if (result.toolUses.length === 0) {
      const parsed = parseAnswer(result.text, toolCalls);
      if (!parsed.ok) return finish({ outcome: "invalid", rawOutput: result.text, errors: parsed.errors });
      return finish({
        outcome: "valid",
        likelyCause: parsed.output.likely_cause,
        confidence: parsed.output.confidence,
        summary: parsed.output.summary,
        evidence: parsed.output.evidence,
        rawOutput: result.text,
        errors: [],
      });
    }

    if (turn === maxTurns) {
      return finish({
        outcome: "step_limit",
        rawOutput: result.text || null,
        errors: [`step limit: the model still asked for tools after ${maxTurns} turns`],
      });
    }

    messages.push({ role: "assistant", content: result.content });
    const results: UserContent[] = [];
    for (const use of result.toolUses) {
      const toolStarted = now();
      const ran = toolCalls.filter((c) => c.result !== TOOL_CAP_RESULT).length;
      const r =
        ran < MAX_TOOL_CALLS
          ? await runTool(use.name, use.input, toolCtx)
          : { content: TOOL_CAP_RESULT, isError: true };
      toolCalls.push({
        turn,
        tool: use.name,
        input: use.input,
        result: r.content,
        is_error: r.isError,
        latency_ms: Math.round(now() - toolStarted),
      });
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
  }
  // Only reached with maxTurns < 1.
  return finish({ outcome: "step_limit", rawOutput: null, errors: ["no turns allowed"] });
}

/** Sent instead of running a tool once MAX_TOOL_CALLS have run. */
export const TOOL_CAP_RESULT = `Tool-call limit (${MAX_TOOL_CALLS}) reached: no more tools run. Give your answer now.`;
