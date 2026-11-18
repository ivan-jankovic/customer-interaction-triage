// Storage of understanding attempts: one row per attempt, never updated. The current
// classification of an interaction is its latest valid row (P03 requirements.md).

import type { Kysely } from "kysely";
import type { Effort } from "../llm/client.js";
import type { ClassificationAttempt } from "../pipeline/understand.js";
import type { ClassificationRow, Database } from "./database.js";

export interface StoredClassification extends ClassificationAttempt {
  id: string;
  interactionId: string;
  createdAt: Date;
}

export interface ClassificationStore {
  record(interactionId: string, attempt: ClassificationAttempt): Promise<StoredClassification>;
  /** The newest valid attempt, ignoring newer invalid or failed ones. */
  latestValid(interactionId: string): Promise<StoredClassification | undefined>;
  /** Every attempt, newest first. */
  listFor(interactionId: string): Promise<StoredClassification[]>;
}

export function toStored(row: ClassificationRow): StoredClassification {
  const classification =
    row.outcome === "valid"
      ? {
          intent: row.intent!,
          urgency: row.urgency!,
          language: row.language!,
          fields: row.fields!,
          summary: row.summary!,
          confidence: row.confidence!,
        }
      : null;
  return {
    id: row.id,
    interactionId: row.interaction_id,
    createdAt: row.created_at,
    outcome: row.outcome,
    classification,
    rawOutput: row.raw_output,
    errors: row.errors,
    promptVersion: row.prompt_version,
    requestedModel: row.requested_model,
    servedModel: row.served_model,
    fellBack: row.fell_back,
    effort: row.effort as Effort,
    usage: {
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_creation_input_tokens: row.cache_creation_input_tokens,
      cache_read_input_tokens: row.cache_read_input_tokens,
    },
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    latencyMs: row.latency_ms,
  };
}

export class KyselyClassificationStore implements ClassificationStore {
  constructor(private readonly db: Kysely<Database>) {}

  async record(interactionId: string, attempt: ClassificationAttempt): Promise<StoredClassification> {
    const c = attempt.classification;
    const row = await this.db
      .insertInto("classifications")
      .values({
        interaction_id: interactionId,
        outcome: attempt.outcome,
        intent: c?.intent ?? null,
        urgency: c?.urgency ?? null,
        language: c?.language ?? null,
        fields: c ? JSON.stringify(c.fields) : null,
        summary: c?.summary ?? null,
        confidence: c?.confidence ?? null,
        raw_output: attempt.rawOutput,
        errors: JSON.stringify(attempt.errors),
        prompt_version: attempt.promptVersion,
        requested_model: attempt.requestedModel,
        served_model: attempt.servedModel,
        fell_back: attempt.fellBack,
        effort: attempt.effort,
        input_tokens: attempt.usage.input_tokens,
        output_tokens: attempt.usage.output_tokens,
        cache_creation_input_tokens: attempt.usage.cache_creation_input_tokens,
        cache_read_input_tokens: attempt.usage.cache_read_input_tokens,
        cost_usd: attempt.costUsd,
        latency_ms: attempt.latencyMs,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toStored(row);
  }

  async latestValid(interactionId: string): Promise<StoredClassification | undefined> {
    const row = await this.db
      .selectFrom("classifications")
      .selectAll()
      .where("interaction_id", "=", interactionId)
      .where("outcome", "=", "valid")
      // uuidv7 ids are time-ordered, and unlike created_at they are unique, so ties can't happen.
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    return row && toStored(row);
  }

  async listFor(interactionId: string): Promise<StoredClassification[]> {
    const rows = await this.db
      .selectFrom("classifications")
      .selectAll()
      .where("interaction_id", "=", interactionId)
      .orderBy("id", "desc")
      .execute();
    return rows.map(toStored);
  }
}
