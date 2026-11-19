// Helpers for the pipeline runner and worker tests (P08): a scripted model client that answers
// classify.v2 requests, and the runner's dependencies around it. No model is ever called.

import type { Kysely } from "kysely";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import type { DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import { readCrmSeed } from "../../src/db/crm-seed.js";
import type { Database } from "../../src/db/database.js";
import type { LlmClient, LlmRequest, LlmResult } from "../../src/llm/client.js";
import { loadPrompt } from "../../src/llm/prompts.js";
import type { ProcessDeps } from "../../src/pipeline/process.js";
import { mask } from "../../src/pipeline/mask.js";
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

export function processDeps(llm: LlmClient): ProcessDeps {
  return { llm, model: "claude-opus-5-5", effort: "low", prompt: loadPrompt(CLASSIFY_PROMPT_VERSION) };
}

/**
 * Stores a dataset message as intake would: its text, channel and the seed's received_at, with
 * an external_id that starts with the dataset ID (so a scripted client can find its labels).
 */
export async function storeMessage(db: Kysely<Database>, messageId: string): Promise<string> {
  const r = record(messageId);
  const m = seed.messages.find((x) => x.message_id === messageId)!;
  const { id } = await db
    .insertInto("interactions")
    .values({
      external_id: `${messageId}-${Math.random().toString(36).slice(2)}`,
      channel: r.channel,
      language: r.language,
      raw_text: r.text,
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
