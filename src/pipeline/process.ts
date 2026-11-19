// The pipeline runner (P08 requirements.md, "Pipeline runner"): mask → classify → enrich →
// investigate (P10) → route for one interaction, used by the queue worker (src/worker.ts) and
// `npm run process`.
//
// Resumable: each step first reuses what is stored, so a job retry (or a second job for the
// same interaction) never pays twice for a classification that succeeded:
// - mask: stored once per interaction (P05);
// - classify: the latest valid attempt; else the latest attempt when it is `invalid` (it would
//   go to review anyway, and a new call costs money); else a new model call;
// - enrich: the latest enrichment made from that classification;
// - investigate (valid technical faults only): the latest investigation of that enrichment,
//   unless its outcome is `error` (then a new attempt; P10 requirements.md, "Retries");
// - route: the existing case.
//
// Retries (requirements.md, "Retries and failures"): a transient model error on a non-final
// attempt throws TransientModelError so the job is retried; on the final attempt it is routed
// (classification_error, review). The investigation follows the same rule: a transient error
// retries the job, and on the final attempt its `error` attempt sends the case to review
// (investigation_inconclusive). Any other error on the final attempt writes a failure case
// (processing_failed) instead of throwing, so every interaction ends as exactly one case.

import type { Kysely } from "kysely";
import { errorClassName, readCase, recordFailureCase, routeInteraction, type RoutedCase } from "../db/cases.js";
import { KyselyClassificationStore, type StoredClassification } from "../db/classifications.js";
import type { Database, DecisionStep } from "../db/database.js";
import { enrichInteraction, latestEnrichmentFor } from "../db/enrichments.js";
import {
  isInvestigated,
  latestInvestigationFor,
  runInvestigation,
  type InvestigatorDeps,
} from "../db/investigations.js";
import { InteractionNotFound, maskInteraction } from "../db/masking.js";
import { understand, type UnderstandDeps } from "./understand.js";

/** process.v2 (P10) adds the investigate step between enrich and route. */
export const PIPELINE_VERSION = "process.v2";

/** A transient model error on a non-final attempt: the job should be retried. */
export class TransientModelError extends Error {}

/**
 * Whether a model call's failure is worth retrying: connection errors and timeouts (no status),
 * 408, 409, 429 and every 5xx (including 529 overloaded). Other 4xx are permanent, and refusals,
 * max_tokens and invalid output are not errors at all (outcome `invalid`).
 */
export function isTransient(attempt: { outcome: string; apiStatus?: number | null }): boolean {
  if (attempt.outcome !== "error") return false;
  const status = attempt.apiStatus;
  // undefined: the attempt didn't come from the API client (unknown cause), so it isn't retried.
  if (status === undefined) return false;
  if (status === null) return true;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** What to do after a classification attempt: retry the job, or go on to enrich and route. */
export function afterClassify(
  attempt: { outcome: string; apiStatus?: number | null },
  { finalAttempt }: { finalAttempt: boolean },
): "retry" | "continue" {
  return isTransient(attempt) && !finalAttempt ? "retry" : "continue";
}

export type StepResult = "ran" | "reused" | "skipped";
export type StepResults = Record<DecisionStep, StepResult>;

export interface ProcessResult {
  case: RoutedCase;
  /** null when the interaction already had a case and nothing ran. */
  steps: StepResults | null;
  /** Set when this call wrote a failure case. */
  failure: { step: DecisionStep; errorClass: string } | null;
}

/** The classifier's dependencies, plus the investigating agent's (P10). */
export type ProcessDeps = Omit<UnderstandDeps, "now"> & { investigator: InvestigatorDeps };

export interface ProcessOptions {
  /** The job's last attempt (always true for `npm run process`): never throws for a retry. */
  finalAttempt: boolean;
}

async function classificationToUse(
  store: KyselyClassificationStore,
  interactionId: string,
): Promise<StoredClassification | undefined> {
  const valid = await store.latestValid(interactionId);
  if (valid) return valid;
  const latest = (await store.listFor(interactionId))[0];
  return latest?.outcome === "invalid" ? latest : undefined;
}

export async function processInteraction(
  db: Kysely<Database>,
  deps: ProcessDeps,
  interactionId: string,
  { finalAttempt }: ProcessOptions,
): Promise<ProcessResult> {
  const existing = await readCase(db, interactionId);
  if (existing) return { case: { ...existing, created: false }, steps: null, failure: null };

  const steps: StepResults = {
    mask: "skipped",
    classify: "skipped",
    enrich: "skipped",
    investigate: "skipped",
    route: "skipped",
  };
  let step: DecisionStep = "mask";
  let classificationId: string | null = null;
  let enrichmentId: string | null = null;
  let investigationId: string | null = null;
  try {
    const interaction = await db
      .selectFrom("interactions")
      .select(["id", "channel"])
      .where("id", "=", interactionId)
      .executeTakeFirst();
    if (!interaction) throw new InteractionNotFound(`No interaction ${interactionId}.`);

    const masking = await maskInteraction(db, interactionId);
    steps.mask = masking.stored === "now" ? "ran" : "reused";

    step = "classify";
    const store = new KyselyClassificationStore(db);
    let classification = await classificationToUse(store, interactionId);
    if (classification) {
      steps.classify = "reused";
    } else {
      const attempt = await understand(
        { maskedText: masking.maskedText, identifiers: masking.identifiers, channel: interaction.channel },
        deps,
      );
      // Stored whatever its outcome, before a retry, so every paid call is counted.
      classification = await store.record(interactionId, attempt);
      steps.classify = "ran";
      if (afterClassify(attempt, { finalAttempt }) === "retry") {
        throw new TransientModelError(`Transient model error (${attempt.errors.join("; ")}); the job will retry.`);
      }
    }
    classificationId = classification.id;

    step = "enrich";
    let enrichment = null;
    if (classification.outcome === "valid") {
      const earlier = await latestEnrichmentFor(db, interactionId, classification.id);
      enrichment = earlier ?? (await enrichInteraction(db, interactionId));
      steps.enrich = earlier ? "reused" : "ran";
      enrichmentId = enrichment.id;
    }

    step = "investigate";
    if (enrichment && isInvestigated(classification)) {
      const earlier = await latestInvestigationFor(db, enrichment.id);
      if (earlier && earlier.outcome !== "error") {
        steps.investigate = "reused";
        investigationId = earlier.id;
      } else {
        // Stored whatever its outcome, before a retry, so every paid call is counted.
        const investigation = await runInvestigation(db, deps.investigator, interactionId, classification, enrichment);
        steps.investigate = "ran";
        investigationId = investigation.id;
        if (afterClassify(investigation, { finalAttempt }) === "retry") {
          throw new TransientModelError(
            `Transient model error in the investigation (${investigation.errors.join("; ")}); the job will retry.`,
          );
        }
      }
    }

    step = "route";
    const routed = await routeInteraction(db, interactionId);
    steps.route = routed.created ? "ran" : "reused";
    return { case: routed, steps, failure: null };
  } catch (error) {
    if (error instanceof TransientModelError || !finalAttempt) throw error;
    // If this write fails too (e.g. PostgreSQL is down), it throws: the job ends failed with no
    // case, and the sweep enqueues the interaction again later.
    const failed = await recordFailureCase(db, interactionId, {
      failedStep: step,
      error,
      classificationId,
      enrichmentId,
      investigationId,
    });
    return { case: failed, steps, failure: { step, errorClass: errorClassName(error) } };
  }
}
