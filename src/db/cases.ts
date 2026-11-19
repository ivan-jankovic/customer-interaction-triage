// The routing step with storage (P07): picks the stored classification and enrichment, routes
// with the rules in src/pipeline/route.ts, and writes the case and its decision log in one
// transaction. One case per interaction: a second call returns the existing case and writes
// nothing, so it is idempotent (P08's jobs rely on this). Free: no model is called.
// From P08, writing a case also marks the interaction `processed`, and recordFailureCase writes
// the case of an interaction whose processing failed for good.
//
// The decision log holds IDs, versions, outcomes and placeholders, never the message text, the
// summary or an identifier value: those stay in their own tables.

import type { Kysely, Transaction } from "kysely";
import { customerServiceTypes, FALLBACK_TEAM, route, ROUTER_VERSION } from "../pipeline/route.js";
import type { CrmServiceType } from "../pipeline/enrich.js";
import type { ReasonCode, Team } from "../taxonomy.js";
import { KyselyClassificationStore, type StoredClassification } from "./classifications.js";
import { KyselyCrm } from "./crm.js";
import type { CaseRow, Database, DecisionLogRow, DecisionStep } from "./database.js";
import { listEnrichments, toStoredEnrichment, type StoredEnrichment } from "./enrichments.js";
import { InteractionNotFound, readMasking } from "./masking.js";

/** Routing needs what earlier steps stored; this says which one is missing. */
export class NotReadyForRouting extends Error {}

export interface DecisionLogEntry {
  seq: number;
  step: DecisionStep;
  inputSummary: Record<string, unknown>;
  output: Record<string, unknown>;
  ruleApplied: string;
  createdAt: Date;
}

export interface StoredCase {
  id: string;
  interactionId: string;
  /** Null only on a failure case that failed before classifying (P08). */
  classificationId: string | null;
  enrichmentId: string | null;
  customerId: string | null;
  targetTeam: Team;
  needsReview: boolean;
  reasonCodes: ReasonCode[];
  routerVersion: string;
  createdAt: Date;
  /** In pipeline order. */
  log: DecisionLogEntry[];
}

export interface RoutedCase extends StoredCase {
  /** false when the interaction already had a case and nothing was written. */
  created: boolean;
}

function toStoredCase(row: CaseRow, log: DecisionLogRow[]): StoredCase {
  return {
    id: row.id,
    interactionId: row.interaction_id,
    classificationId: row.classification_id,
    enrichmentId: row.enrichment_id,
    customerId: row.customer_id,
    targetTeam: row.target_team,
    needsReview: row.needs_review,
    reasonCodes: row.reason_codes,
    routerVersion: row.router_version,
    createdAt: row.created_at,
    log: log.map((l) => ({
      seq: l.seq,
      step: l.step,
      inputSummary: l.input_summary,
      output: l.output,
      ruleApplied: l.rule_applied,
      createdAt: l.created_at,
    })),
  };
}

/** The interaction's case with its decision log, or null when it has none. */
export async function readCase(db: Kysely<Database>, interactionId: string): Promise<StoredCase | null> {
  const row = await db.selectFrom("cases").selectAll().where("interaction_id", "=", interactionId).executeTakeFirst();
  if (!row) return null;
  const log = await db.selectFrom("decision_log").selectAll().where("case_id", "=", row.id).orderBy("seq").execute();
  return toStoredCase(row, log);
}

/** The classification used: the latest valid one, else the latest attempt (invalid or error). */
async function pickClassification(db: Kysely<Database>, interactionId: string): Promise<StoredClassification> {
  const store = new KyselyClassificationStore(db);
  const chosen = (await store.latestValid(interactionId)) ?? (await store.listFor(interactionId))[0];
  if (!chosen) throw new NotReadyForRouting(`Interaction ${interactionId} has no classification; classify first.`);
  return chosen;
}

/** The latest enrichment made from this classification; an older classification's doesn't count. */
async function pickEnrichment(
  db: Kysely<Database>,
  interactionId: string,
  classificationId: string,
): Promise<StoredEnrichment> {
  const row = await db
    .selectFrom("enrichments")
    .selectAll()
    .where("interaction_id", "=", interactionId)
    .where("classification_id", "=", classificationId)
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    throw new NotReadyForRouting(
      `Interaction ${interactionId} has no enrichment of its current classification; enrich first.`,
    );
  }
  return toStoredEnrichment(row);
}

const countBy = <T>(items: readonly T[], key: (t: T) => string) => {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
};

interface StepsInput {
  channel: string;
  /** Null when masking didn't finish (failure cases only). */
  masking: NonNullable<Awaited<ReturnType<typeof readMasking>>> | null;
  classification: StoredClassification | null;
  enrichment: StoredEnrichment | null;
}

type NewLogEntry = Omit<DecisionLogEntry, "seq" | "createdAt">;

/** One entry per finished step before routing; IDs, versions, outcomes and placeholders only. */
function stepEntries(interactionId: string, x: StepsInput): NewLogEntry[] {
  const entries: NewLogEntry[] = [];
  const m = x.masking;
  if (m) {
    const placeholdersByType: Record<string, string[]> = {};
    for (const i of m.identifiers) (placeholdersByType[i.type] ??= []).push(i.placeholder);
    entries.push({
      step: "mask",
      inputSummary: { interaction_id: interactionId, channel: x.channel },
      output: { placeholders: placeholdersByType },
      ruleApplied: m.maskerVersion,
    });
  }
  const c = x.classification;
  if (c) {
    entries.push({
      step: "classify",
      inputSummary: {
        classification_id: c.id,
        prompt_version: c.promptVersion,
        identifier_types: countBy(m?.identifiers ?? [], (i) => i.type),
      },
      output: {
        outcome: c.outcome,
        intent: c.classification?.intent ?? null,
        urgency: c.classification?.urgency ?? null,
        service_type: c.classification?.fields.service_type ?? null,
        area: c.classification?.fields.area ?? null,
        confidence: c.classification?.confidence ?? null,
      },
      ruleApplied: `${c.promptVersion} / ${c.servedModel}`,
    });
  }
  const e = x.enrichment;
  if (e) {
    entries.push({
      step: "enrich",
      inputSummary: { enrichment_id: e.id, classification_id: e.classificationId },
      output: {
        outcome: e.outcome,
        customer_id: e.customerId,
        candidate_count: e.candidates.length,
        unmatched_placeholders: e.unmatchedPlaceholders,
        area: e.area,
        area_source: e.areaSource,
        outage_ids: e.outageIds,
      },
      ruleApplied: e.enricherVersion,
    });
  }
  return entries;
}

function routeEntry(
  x: StepsInput & { serviceTypes: CrmServiceType[] },
  output: { targetTeam: Team; needsReview: boolean; firedRules: { reasonCode: ReasonCode; detail: string }[] },
): NewLogEntry {
  return {
    step: "route",
    inputSummary: {
      classification_id: x.classification?.id ?? null,
      enrichment_id: x.enrichment?.id ?? null,
      customer_service_types: x.serviceTypes,
    },
    output: {
      target_team: output.targetTeam,
      needs_review: output.needsReview,
      fired_rules: output.firedRules.map((r) => ({ reason_code: r.reasonCode, detail: r.detail })),
    },
    ruleApplied: ROUTER_VERSION,
  };
}

/** Sets the interaction's status; called inside the transaction that writes its case (P08). */
async function markProcessed(trx: Transaction<Database>, interactionId: string): Promise<void> {
  await trx.updateTable("interactions").set({ status: "processed" }).where("id", "=", interactionId).execute();
}

interface NewCase {
  interactionId: string;
  classificationId: string | null;
  enrichmentId: string | null;
  customerId: string | null;
  targetTeam: Team;
  needsReview: boolean;
  reasonCodes: ReasonCode[];
}

/**
 * Inserts the case, marks the interaction processed and writes the log, in one transaction.
 * ON CONFLICT DO NOTHING on the unique interaction_id: when two calls race (or a failure case
 * races a normal one), one inserts the case and its log; the other writes nothing. Returns
 * whether this call inserted.
 */
async function insertCase(db: Kysely<Database>, c: NewCase, log: NewLogEntry[]): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto("cases")
      .values({
        interaction_id: c.interactionId,
        classification_id: c.classificationId,
        enrichment_id: c.enrichmentId,
        customer_id: c.customerId,
        target_team: c.targetTeam,
        needs_review: c.needsReview,
        reason_codes: JSON.stringify(c.reasonCodes),
        router_version: ROUTER_VERSION,
      })
      .onConflict((oc) => oc.column("interaction_id").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!row) return false;
    await markProcessed(trx, c.interactionId);
    await trx
      .insertInto("decision_log")
      .values(
        log.map((entry, i) => ({
          case_id: row.id,
          seq: i + 1,
          step: entry.step,
          input_summary: JSON.stringify(entry.inputSummary),
          output: JSON.stringify(entry.output),
          rule_applied: entry.ruleApplied,
        })),
      )
      .execute();
    return true;
  });
}

async function readChannel(db: Kysely<Database>, interactionId: string): Promise<string> {
  const interaction = await db
    .selectFrom("interactions")
    .select("channel")
    .where("id", "=", interactionId)
    .executeTakeFirst();
  if (!interaction) throw new InteractionNotFound(`No interaction ${interactionId}.`);
  return interaction.channel;
}

export async function routeInteraction(db: Kysely<Database>, interactionId: string): Promise<RoutedCase> {
  const existing = await readCase(db, interactionId);
  if (existing) return { ...existing, created: false };

  const channel = await readChannel(db, interactionId);
  const masking = await readMasking(db, interactionId);
  if (!masking) throw new NotReadyForRouting(`Interaction ${interactionId} is not masked yet; classify first.`);
  const classification = await pickClassification(db, interactionId);
  const valid = classification.outcome === "valid" && classification.classification !== null;
  const enrichment = valid ? await pickEnrichment(db, interactionId, classification.id) : null;
  const serviceTypes = await customerServiceTypes(new KyselyCrm(db), enrichment?.customerId ?? null);

  const result = route({
    outcome: classification.outcome,
    classification: classification.classification,
    enrichment,
    customerServiceTypes: serviceTypes,
  });
  const steps = { channel, masking, classification, enrichment, serviceTypes };
  const log = [...stepEntries(interactionId, steps), routeEntry(steps, result)];

  const created = await insertCase(
    db,
    {
      interactionId,
      classificationId: classification.id,
      enrichmentId: enrichment?.id ?? null,
      customerId: enrichment?.customerId ?? null,
      targetTeam: result.targetTeam,
      needsReview: result.needsReview,
      reasonCodes: result.reasonCodes,
    },
    log,
  );

  const stored = await readCase(db, interactionId);
  return { ...stored!, created };
}

/** The pipeline steps a failure case can name (P08). */
export type PipelineStep = DecisionStep;

export interface FailureInput {
  /** The step that threw on the job's last attempt. */
  failedStep: PipelineStep;
  error: unknown;
  /** What earlier steps stored and the runner had in hand; null when they didn't finish. */
  classificationId: string | null;
  enrichmentId: string | null;
}

/** The error's class name only: a message can quote values (a database error, for example). */
export function errorClassName(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name || "Error";
  return typeof error;
}

/**
 * Writes the failure case of an interaction whose processing failed on its last job attempt
 * (P08 requirements.md, "Other failures"): team general, reason code processing_failed, the
 * IDs of the steps that finished, and a decision log of those steps plus a route entry naming
 * the failed step and the error's class. Returns the existing case when there already is one.
 */
export async function recordFailureCase(
  db: Kysely<Database>,
  interactionId: string,
  failure: FailureInput,
): Promise<RoutedCase> {
  const existing = await readCase(db, interactionId);
  if (existing) return { ...existing, created: false };

  const channel = await readChannel(db, interactionId);
  const masking = await readMasking(db, interactionId);
  const classification = failure.classificationId
    ? ((await new KyselyClassificationStore(db).listFor(interactionId)).find(
        (c) => c.id === failure.classificationId,
      ) ?? null)
    : null;
  const enrichment = failure.enrichmentId
    ? ((await listEnrichments(db, interactionId)).find((e) => e.id === failure.enrichmentId) ?? null)
    : null;

  const firedRules = [
    {
      reasonCode: "processing_failed" as const,
      detail: `failed at ${failure.failedStep}: ${errorClassName(failure.error)}`,
    },
  ];
  const steps = { channel, masking, classification, enrichment, serviceTypes: [] };
  const log = [
    ...stepEntries(interactionId, steps),
    routeEntry(steps, { targetTeam: FALLBACK_TEAM, needsReview: true, firedRules }),
  ];

  const created = await insertCase(
    db,
    {
      interactionId,
      classificationId: classification?.id ?? null,
      enrichmentId: enrichment?.id ?? null,
      customerId: enrichment?.customerId ?? null,
      targetTeam: FALLBACK_TEAM,
      needsReview: true,
      reasonCodes: ["processing_failed"],
    },
    log,
  );
  const stored = await readCase(db, interactionId);
  return { ...stored!, created };
}
