// The investigate step with storage (P10): reads what earlier steps stored, runs the agent
// (src/pipeline/investigate.ts) with the tools reading the CRM in read-only transactions, and
// records one investigations row per attempt, never updated. The investigation that counts for
// an enrichment is its latest row. Paid: the agent calls a model.

import type { Kysely } from "kysely";
import type { ConverseClient, Effort } from "../llm/client.js";
import type { PromptTemplate } from "../llm/prompts.js";
import {
  INVESTIGATOR_VERSION,
  investigate,
  type InvestigateInput,
  type InvestigationAttempt,
} from "../pipeline/investigate.js";
import type { StoredClassification } from "./classifications.js";
import { KyselyClassificationStore } from "./classifications.js";
import { readOnlyCrm } from "./crm.js";
import type { Database, InvestigationRow } from "./database.js";
import { latestEnrichmentFor, type StoredEnrichment } from "./enrichments.js";
import { InteractionNotFound } from "./masking.js";

/** Investigation needs what earlier steps stored; this says which one is missing. */
export class NotReadyForInvestigation extends Error {}

export interface StoredInvestigation extends InvestigationAttempt {
  id: string;
  interactionId: string;
  classificationId: string;
  enrichmentId: string;
  investigatorVersion: string;
  createdAt: Date;
}

/** The agent's model, effort, prompt and client. */
export interface InvestigatorDeps {
  llm: ConverseClient;
  model: string;
  effort: Effort;
  prompt: PromptTemplate;
}

export function toStoredInvestigation(row: InvestigationRow): StoredInvestigation {
  return {
    id: row.id,
    interactionId: row.interaction_id,
    classificationId: row.classification_id,
    enrichmentId: row.enrichment_id,
    investigatorVersion: row.investigator_version,
    createdAt: row.created_at,
    outcome: row.outcome,
    likelyCause: row.likely_cause,
    confidence: row.confidence === null ? null : Number(row.confidence),
    summary: row.summary,
    evidence: row.evidence as InvestigationAttempt["evidence"],
    steps: row.steps,
    toolCalls: row.tool_calls,
    rawOutput: row.raw_output,
    errors: row.errors,
    promptVersion: row.prompt_version,
    requestedModel: row.requested_model,
    servedModel: row.served_model,
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

export async function recordInvestigation(
  db: Kysely<Database>,
  ids: { interactionId: string; classificationId: string; enrichmentId: string },
  a: InvestigationAttempt,
): Promise<StoredInvestigation> {
  const row = await db
    .insertInto("investigations")
    .values({
      interaction_id: ids.interactionId,
      classification_id: ids.classificationId,
      enrichment_id: ids.enrichmentId,
      investigator_version: INVESTIGATOR_VERSION,
      prompt_version: a.promptVersion,
      outcome: a.outcome,
      likely_cause: a.likelyCause,
      confidence: a.confidence,
      summary: a.summary,
      evidence: JSON.stringify(a.evidence),
      steps: a.steps,
      tool_calls: JSON.stringify(a.toolCalls),
      raw_output: a.rawOutput,
      errors: JSON.stringify(a.errors),
      requested_model: a.requestedModel,
      served_model: a.servedModel,
      effort: a.effort,
      input_tokens: a.usage.input_tokens,
      output_tokens: a.usage.output_tokens,
      cache_creation_input_tokens: a.usage.cache_creation_input_tokens,
      cache_read_input_tokens: a.usage.cache_read_input_tokens,
      cost_usd: a.costUsd,
      latency_ms: a.latencyMs,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toStoredInvestigation(row);
}

/** The latest investigation made from this enrichment, or null. */
export async function latestInvestigationFor(
  db: Kysely<Database>,
  enrichmentId: string,
): Promise<StoredInvestigation | null> {
  const row = await db
    .selectFrom("investigations")
    .selectAll()
    .where("enrichment_id", "=", enrichmentId)
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  return row ? toStoredInvestigation(row) : null;
}

export async function investigationById(db: Kysely<Database>, id: string): Promise<StoredInvestigation | null> {
  const row = await db.selectFrom("investigations").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? toStoredInvestigation(row) : null;
}

/** Whether a classification is one the agent investigates: valid, intent technical_fault. */
export function isInvestigated(c: Pick<StoredClassification, "outcome" | "classification">): boolean {
  return c.outcome === "valid" && c.classification?.intent === "technical_fault";
}

/** Everything the agent's input needs, from what earlier steps stored. */
export async function investigationInput(
  db: Kysely<Database>,
  interactionId: string,
  classification: StoredClassification,
  enrichment: StoredEnrichment,
): Promise<InvestigateInput> {
  const interaction = await db
    .selectFrom("interactions")
    .select(["channel", "received_at", "masked_text"])
    .where("id", "=", interactionId)
    .executeTakeFirst();
  if (!interaction) throw new InteractionNotFound(`No interaction ${interactionId}.`);
  if (interaction.masked_text === null) {
    throw new NotReadyForInvestigation(`Interaction ${interactionId} is not masked yet.`);
  }
  const c = classification.classification!;
  return {
    maskedText: interaction.masked_text,
    channel: interaction.channel,
    receivedAt: interaction.received_at,
    classification: { serviceType: c.fields.service_type, area: c.fields.area, summary: c.summary },
    enrichment: {
      outcome: enrichment.outcome,
      customerId: enrichment.customerId,
      candidateIds: enrichment.candidates.map((x) => x.customerId),
      area: enrichment.area,
      areaSource: enrichment.areaSource,
    },
  };
}

/** Runs the agent for a stored classification and enrichment and records the attempt; returns it with apiStatus. */
export async function runInvestigation(
  db: Kysely<Database>,
  deps: InvestigatorDeps,
  interactionId: string,
  classification: StoredClassification,
  enrichment: StoredEnrichment,
): Promise<StoredInvestigation> {
  const input = await investigationInput(db, interactionId, classification, enrichment);
  const attempt = await investigate(input, { ...deps, crm: readOnlyCrm(db) });
  const stored = await recordInvestigation(
    db,
    { interactionId, classificationId: classification.id, enrichmentId: enrichment.id },
    attempt,
  );
  // apiStatus isn't stored (as for classifications), but the runner needs it to decide whether
  // to retry the job (P08), so it is carried over from the attempt.
  return attempt.apiStatus === undefined ? stored : { ...stored, apiStatus: attempt.apiStatus };
}

/**
 * What `npm run investigate` needs: the current (latest valid) classification, a technical
 * fault, and its latest enrichment. Throws NotReadyForInvestigation naming what is missing.
 */
export async function investigationInputs(
  db: Kysely<Database>,
  interactionId: string,
): Promise<{ classification: StoredClassification; enrichment: StoredEnrichment }> {
  const classification = await new KyselyClassificationStore(db).latestValid(interactionId);
  if (!classification) {
    throw new NotReadyForInvestigation(`Interaction ${interactionId} has no valid classification; classify first.`);
  }
  if (!isInvestigated(classification)) {
    throw new NotReadyForInvestigation(
      `Interaction ${interactionId} is classified as ${classification.classification!.intent}; only technical faults are investigated.`,
    );
  }
  const enrichment = await latestEnrichmentFor(db, interactionId, classification.id);
  if (!enrichment) {
    throw new NotReadyForInvestigation(`Interaction ${interactionId} has no enrichment; enrich first.`);
  }
  return { classification, enrichment };
}
