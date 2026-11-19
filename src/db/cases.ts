// The routing step with storage (P07): picks the stored classification and enrichment, routes
// with the rules in src/pipeline/route.ts, and writes the case and its decision log in one
// transaction. One case per interaction: a second call returns the existing case and writes
// nothing, so it is idempotent (P08's jobs rely on this). Free: no model is called.
//
// The decision log holds IDs, versions, outcomes and placeholders, never the message text, the
// summary or an identifier value: those stay in their own tables.

import type { Kysely } from "kysely";
import { customerServiceTypes, route, ROUTER_VERSION, type RouteResult } from "../pipeline/route.js";
import type { CrmServiceType } from "../pipeline/enrich.js";
import type { ReasonCode, Team } from "../taxonomy.js";
import { KyselyClassificationStore, type StoredClassification } from "./classifications.js";
import { KyselyCrm } from "./crm.js";
import type { CaseRow, Database, DecisionLogRow, DecisionStep } from "./database.js";
import { toStoredEnrichment, type StoredEnrichment } from "./enrichments.js";
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
  classificationId: string;
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

interface LogInput {
  channel: string;
  masking: NonNullable<Awaited<ReturnType<typeof readMasking>>>;
  classification: StoredClassification;
  enrichment: StoredEnrichment | null;
  serviceTypes: CrmServiceType[];
  result: RouteResult;
}

/** One entry per step; IDs, versions, outcomes and placeholders only. */
function buildLog(interactionId: string, x: LogInput): Omit<DecisionLogEntry, "seq" | "createdAt">[] {
  const placeholdersByType: Record<string, string[]> = {};
  for (const i of x.masking.identifiers) (placeholdersByType[i.type] ??= []).push(i.placeholder);
  const c = x.classification;
  const entries: Omit<DecisionLogEntry, "seq" | "createdAt">[] = [
    {
      step: "mask",
      inputSummary: { interaction_id: interactionId, channel: x.channel },
      output: { placeholders: placeholdersByType },
      ruleApplied: x.masking.maskerVersion,
    },
    {
      step: "classify",
      inputSummary: {
        classification_id: c.id,
        prompt_version: c.promptVersion,
        identifier_types: countBy(x.masking.identifiers, (i) => i.type),
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
    },
  ];
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
  entries.push({
    step: "route",
    inputSummary: {
      classification_id: c.id,
      enrichment_id: e?.id ?? null,
      customer_service_types: x.serviceTypes,
    },
    output: {
      target_team: x.result.targetTeam,
      needs_review: x.result.needsReview,
      fired_rules: x.result.firedRules.map((r) => ({ reason_code: r.reasonCode, detail: r.detail })),
    },
    ruleApplied: ROUTER_VERSION,
  });
  return entries;
}

export async function routeInteraction(db: Kysely<Database>, interactionId: string): Promise<RoutedCase> {
  const existing = await readCase(db, interactionId);
  if (existing) return { ...existing, created: false };

  const interaction = await db
    .selectFrom("interactions")
    .select(["id", "channel"])
    .where("id", "=", interactionId)
    .executeTakeFirst();
  if (!interaction) throw new InteractionNotFound(`No interaction ${interactionId}.`);

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
  const log = buildLog(interactionId, {
    channel: interaction.channel,
    masking,
    classification,
    enrichment,
    serviceTypes,
    result,
  });

  // ON CONFLICT DO NOTHING on the unique interaction_id: when two calls race, one inserts the
  // case and its log; the other inserts nothing, writes no log, and reads the winner's case.
  const created = await db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto("cases")
      .values({
        interaction_id: interactionId,
        classification_id: classification.id,
        enrichment_id: enrichment?.id ?? null,
        customer_id: enrichment?.customerId ?? null,
        target_team: result.targetTeam,
        needs_review: result.needsReview,
        reason_codes: JSON.stringify(result.reasonCodes),
        router_version: ROUTER_VERSION,
      })
      .onConflict((oc) => oc.column("interaction_id").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!row) return false;
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

  const stored = await readCase(db, interactionId);
  return { ...stored!, created };
}
