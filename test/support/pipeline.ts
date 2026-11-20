// Helpers for the pipeline runner and worker tests (P08): a scripted model client that answers
// classify.v2 requests, a scripted investigating agent (P10), and the runner's dependencies
// around them. No model is ever called.

import type { Kysely } from "kysely";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import type { DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import { readCrmSeed } from "../../src/db/crm-seed.js";
import type { Database } from "../../src/db/database.js";
import type {
  ConverseClient,
  ConverseRequest,
  ConverseResult,
  LlmClient,
  LlmRequest,
  LlmResult,
} from "../../src/llm/client.js";
import { loadPrompt } from "../../src/llm/prompts.js";
import type { ProcessDeps } from "../../src/pipeline/process.js";
import { mask } from "../../src/pipeline/mask.js";
import { INVESTIGATE_PROMPT_VERSION } from "../../src/pipeline/investigate.js";
import { CLASSIFY_PROMPT_VERSION, escapeMessage } from "../../src/pipeline/understand.js";

const USAGE = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

export const seed = readCrmSeed();
export const dataset = readJsonl<DatasetRecord>(PATHS.dataset);

export const record = (messageId: string) => dataset.find((x) => x.id === messageId)!;
export const labelsOf = (messageId: string) => {
  const r = record(messageId);
  return r.final ?? r.chosen;
};

/**
 * One scripted answer:
 * - "valid": a classify.v2 output carrying the message's labelled intent, area and service type;
 * - "invalid": text that fails validation;
 * - { status }: an API error with that HTTP status (null = connection error);
 * - "throw": the client throws a plain Error (a bug, not an API error).
 */
export type Answer = "valid" | "invalid" | "throw" | { status: number | null };

/** The classify.v2 output for a dataset message, with its labels (the model returns no identifiers). */
export function outputFor(messageId: string, confidence = 0.9): string {
  const labels = labelsOf(messageId);
  return JSON.stringify({
    intent: labels.intent,
    urgency: labels.urgency,
    language: record(messageId).language,
    fields: { service_type: labels.fields.service_type, area: labels.fields.area },
    summary: "Customer writes about their service.",
    confidence,
  });
}

/**
 * A model client that answers from a script by call index (the last answer repeats). The
 * message is told apart by its masked text, so one client serves several interactions:
 * `messageOf(req)` returns the dataset ID whose labels the "valid" answer carries.
 */
export function scriptedLlm(
  script: Answer[] | ((callIndex: number) => Answer),
  messageOf: (req: LlmRequest) => string,
): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    complete(req): Promise<LlmResult> {
      const i = calls.length;
      calls.push(req);
      const answer = typeof script === "function" ? script(i) : script[Math.min(i, script.length - 1)]!;
      if (answer === "throw") return Promise.reject(new Error("bug in the client"));
      if (answer === "invalid")
        return Promise.resolve({ ok: true, text: "not json {", model: req.model, usage: USAGE });
      if (answer === "valid") {
        return Promise.resolve({ ok: true, text: outputFor(messageOf(req)), model: req.model, usage: USAGE });
      }
      return Promise.resolve({
        ok: false,
        error: `API error ${answer.status ?? "?"}: scripted`,
        failure: "api_error",
        status: answer.status,
        model: req.model,
        usage: USAGE,
      });
    },
  };
}

/**
 * One scripted investigation (P10), played per investigation (a conversation's first turn
 * starts the next one):
 * - "conclusive": calls check_outages once, then answers area_outage at 0.9 citing it;
 * - "inconclusive": calls check_outages once, then answers inconclusive;
 * - "loop": asks for check_outages every turn, so it ends at the step limit;
 * - { status }: the first turn fails with that API status (null = connection error);
 * - "throw": the client throws a plain Error.
 */
export type Investigation = "conclusive" | "inconclusive" | "loop" | "throw" | { status: number | null };

export function scriptedAgent(
  script: Investigation[] = ["conclusive"],
): ConverseClient & { calls: ConverseRequest[]; investigations: number } {
  const calls: ConverseRequest[] = [];
  const agent = {
    calls,
    investigations: 0,
    converse(req: ConverseRequest): Promise<ConverseResult> {
      calls.push(req);
      if (req.messages.length === 1) agent.investigations++;
      const plan = script[Math.min(agent.investigations - 1, script.length - 1)]!;
      if (plan === "throw") return Promise.reject(new Error("bug in the agent client"));
      if (typeof plan === "object") {
        return Promise.resolve({
          ok: false,
          error: `API error ${plan.status ?? "?"}: scripted`,
          failure: "api_error",
          status: plan.status,
          model: req.model,
          usage: USAGE,
        });
      }
      if (req.messages.length === 1 || plan === "loop") {
        const use = { id: `tu_${calls.length}`, name: "check_outages", input: { area: "Opava" } };
        return Promise.resolve({
          ok: true,
          content: [{ type: "tool_use", ...use }],
          toolUses: [use],
          text: "",
          stopReason: "tool_use",
          model: req.model,
          usage: USAGE,
        });
      }
      const text = JSON.stringify(
        plan === "conclusive"
          ? {
              likely_cause: "area_outage",
              confidence: 0.9,
              summary: "An outage covers the area.",
              evidence: [{ tool: "check_outages", finding: "An outage in the area." }],
            }
          : { likely_cause: "inconclusive", confidence: 0.4, summary: "Nothing found.", evidence: [] },
      );
      return Promise.resolve({
        ok: true,
        content: [{ type: "text", text }],
        toolUses: [],
        text,
        stopReason: "end_turn",
        model: req.model,
        usage: USAGE,
      });
    },
  };
  return agent;
}

export function processDeps(llm: LlmClient, agent: ConverseClient = scriptedAgent()): ProcessDeps {
  return {
    llm,
    model: "claude-opus-5-5",
    effort: "low",
    prompt: loadPrompt(CLASSIFY_PROMPT_VERSION),
    investigator: {
      llm: agent,
      model: "claude-opus-5-5",
      effort: "low",
      prompt: loadPrompt(INVESTIGATE_PROMPT_VERSION),
    },
  };
}

/**
 * Stores a dataset message as intake would: its text, channel and the seed's received_at, with
 * an external_id that starts with the dataset ID (so a scripted client can find its labels).
 */
/** Stores a dataset message; `text` replaces its text (keep the start, which byMaskedText matches on). */
export async function storeMessage(
  db: Kysely<Database>,
  messageId: string,
  overrides: { text?: string } = {},
): Promise<string> {
  const r = record(messageId);
  const m = seed.messages.find((x) => x.message_id === messageId)!;
  const { id } = await db
    .insertInto("interactions")
    .values({
      external_id: `${messageId}-${Math.random().toString(36).slice(2)}`,
      channel: r.channel,
      language: r.language,
      raw_text: overrides.text ?? r.text,
      received_at: m.received_at,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return id;
}

/** For scriptedLlm: finds which of these dataset messages a request is about, by its masked text. */
export function byMaskedText(messageIds: readonly string[]): (req: LlmRequest) => string {
  const starts = messageIds.map((id) => [id, escapeMessage(mask(record(id).text).maskedText).slice(0, 60)] as const);
  return (req) => {
    const found = starts.find(([, start]) => req.user.includes(start));
    if (!found) throw new Error("scripted LLM: a request for an unknown message");
    return found[0];
  };
}
