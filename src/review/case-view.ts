// Everything the reviewer sees about a case (P09 requirements.md, "What show prints"), read from
// what earlier steps stored; no model is called. Masked text only: the raw text is returned by
// unmaskCase (src/review/actions.ts), which logs the view first. No identifier value is included:
// the found customer is shown by ID, segment and services, not by customer number.

import type { Kysely } from "kysely";
import { readCase, type StoredCase } from "../db/cases.js";
import { KyselyClassificationStore, type StoredClassification } from "../db/classifications.js";
import { outagesByIds } from "../db/crm.js";
import type { Database } from "../db/database.js";
import { listEnrichments, type StoredEnrichment } from "../db/enrichments.js";
import { investigationById } from "../db/investigations.js";
import type { StoredToolCall } from "../db/database.js";
import type { Channel, Intent, Language, Team } from "../taxonomy.js";
import type { ReviewDecision } from "./rules.js";

export interface StoredReview {
  id: string;
  caseId: string;
  reviewer: string;
  decision: ReviewDecision;
  correctedIntent: Intent | null;
  correctedTeam: Team | null;
  note: string | null;
  spotCheck: boolean;
  reviewedAt: Date;
}

export interface Unmasking {
  reviewer: string;
  reason: string;
  unmaskedAt: Date;
}

export interface CaseView {
  case: StoredCase;
  interaction: {
    id: string;
    externalId: string | null;
    channel: Channel;
    language: Language | null;
    receivedAt: Date;
    /** Null when masking never finished (a failure case at the mask step). */
    maskedText: string | null;
  };
  /**
   * The classification attempt the case used; null for a failure case before classifying. Its
   * fields.identifiers are left out: they hold the identifier values (from the masking map).
   */
  classification: ClassificationSummary | null;
  enrichment: StoredEnrichment | null;
  /** The found customer, without identifier values. */
  customer: {
    id: string;
    segment: string;
    services: { service_type: string; tariff: string; area: string; status: string }[];
  } | null;
  outages: Awaited<ReturnType<typeof outagesByIds>>;
  /**
   * P10: the investigation the case was routed with (named by its decision log), or why there is
   * none; null when the case has no investigate entry (cases written before P10, or an invalid
   * classification).
   */
  investigation: InvestigationView | { skipped: string } | null;
  review: StoredReview | null;
  unmaskings: Unmasking[];
}

export interface ClassificationSummary {
  id: string;
  outcome: StoredClassification["outcome"];
  intent: Intent | null;
  urgency: string | null;
  confidence: number | null;
  serviceType: string | null;
  area: string | null;
  summary: string | null;
  errors: string[];
  promptVersion: string;
  servedModel: string;
}

function summarize(c: StoredClassification): ClassificationSummary {
  const v = c.classification;
  return {
    id: c.id,
    outcome: c.outcome,
    intent: v?.intent ?? null,
    urgency: v?.urgency ?? null,
    confidence: v?.confidence ?? null,
    serviceType: v?.fields.service_type ?? null,
    area: v?.fields.area ?? null,
    summary: v?.summary ?? null,
    errors: c.errors,
    promptVersion: c.promptVersion,
    servedModel: c.servedModel,
  };
}

/** An investigation as the reviewer sees it: tool names, inputs and error flags, not the results. */
export interface InvestigationView {
  id: string;
  outcome: string;
  likelyCause: string | null;
  confidence: number | null;
  summary: string | null;
  evidence: { tool: string; finding: string }[];
  errors: string[];
  steps: number;
  toolCalls: Pick<StoredToolCall, "turn" | "tool" | "input" | "is_error">[];
  servedModel: string;
}

async function readInvestigation(db: Kysely<Database>, c: StoredCase): Promise<CaseView["investigation"]> {
  const entry = c.log.find((l) => l.step === "investigate");
  if (!entry) return null;
  const id = entry.inputSummary.investigation_id;
  if (typeof id !== "string") {
    const skipped = entry.output.skipped;
    return { skipped: typeof skipped === "string" ? skipped : "not investigated" };
  }
  const i = await investigationById(db, id);
  if (!i) return { skipped: `investigation ${id} not found` };
  return {
    id: i.id,
    outcome: i.outcome,
    likelyCause: i.likelyCause,
    confidence: i.confidence,
    summary: i.summary,
    evidence: i.evidence,
    errors: i.errors,
    steps: i.steps,
    toolCalls: i.toolCalls.map(({ turn, tool, input, is_error }) => ({ turn, tool, input, is_error })),
    servedModel: i.servedModel,
  };
}

export class CaseNotFound extends Error {}

export async function readReview(db: Kysely<Database>, caseId: string): Promise<StoredReview | null> {
  const r = await db.selectFrom("reviews").selectAll().where("case_id", "=", caseId).executeTakeFirst();
  return r
    ? {
        id: r.id,
        caseId: r.case_id,
        reviewer: r.reviewer,
        decision: r.decision,
        correctedIntent: r.corrected_intent,
        correctedTeam: r.corrected_team,
        note: r.note,
        spotCheck: r.spot_check,
        reviewedAt: r.reviewed_at,
      }
    : null;
}

export async function readCaseView(db: Kysely<Database>, caseId: string): Promise<CaseView> {
  const row = await db.selectFrom("cases").select("interaction_id").where("id", "=", caseId).executeTakeFirst();
  if (!row) throw new CaseNotFound(`No case ${caseId}.`);
  const c = (await readCase(db, row.interaction_id))!;

  const i = await db
    .selectFrom("interactions")
    .select(["id", "external_id", "channel", "language", "received_at", "masked_text"])
    .where("id", "=", c.interactionId)
    .executeTakeFirstOrThrow();
  const stored = c.classificationId
    ? (await new KyselyClassificationStore(db).listFor(c.interactionId)).find((x) => x.id === c.classificationId)
    : undefined;
  const classification = stored ? summarize(stored) : null;
  const enrichment = c.enrichmentId
    ? ((await listEnrichments(db, c.interactionId)).find((e) => e.id === c.enrichmentId) ?? null)
    : null;

  let customer: CaseView["customer"] = null;
  if (c.customerId) {
    const cust = await db
      .selectFrom("crm_customers")
      .select(["id", "segment"])
      .where("id", "=", c.customerId)
      .executeTakeFirstOrThrow();
    const services = await db
      .selectFrom("crm_services")
      .select(["service_type", "tariff", "area", "status"])
      .where("customer_id", "=", c.customerId)
      .orderBy("started_at")
      .execute();
    customer = { ...cust, services };
  }

  const unmaskings = await db
    .selectFrom("unmask_log")
    .select(["reviewer", "reason", "unmasked_at"])
    .where("case_id", "=", caseId)
    .orderBy("id")
    .execute();

  return {
    case: c,
    interaction: {
      id: i.id,
      externalId: i.external_id,
      channel: i.channel,
      language: i.language,
      receivedAt: i.received_at,
      maskedText: i.masked_text,
    },
    classification,
    enrichment,
    customer,
    outages: await outagesByIds(db, enrichment?.outageIds ?? []),
    investigation: await readInvestigation(db, c),
    review: await readReview(db, caseId),
    unmaskings: unmaskings.map((u) => ({ reviewer: u.reviewer, reason: u.reason, unmaskedAt: u.unmasked_at })),
  };
}
