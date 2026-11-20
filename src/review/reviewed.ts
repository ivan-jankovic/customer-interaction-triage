// The reviewed cases list of the web page (P13 requirements.md, "The reviewed cases list"):
// reviews newest first, with the case's own intent and team and the effective decision.
// Read-only; reviews are never changed (P09).

import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";
import type { Intent, Team } from "../taxonomy.js";
import { effectiveDecision, type EffectiveDecision, type ReviewDecision } from "./rules.js";

export interface ReviewedRow {
  reviewId: string;
  caseId: string;
  externalId: string | null;
  reviewer: string;
  decision: ReviewDecision;
  spotCheck: boolean;
  reviewedAt: Date;
  note: string | null;
  /** What the case itself said: the classification's intent (null without one) and the target team. */
  original: { intent: Intent | null; team: Team };
  effective: EffectiveDecision;
}

export interface ReviewedFilters {
  reviewer?: string | undefined;
  decision?: ReviewDecision | undefined;
}

/** A page of reviews, newest first; `before` is the last review ID of the previous page (uuidv7). */
export async function listReviewed(
  db: Kysely<Database>,
  filters: ReviewedFilters,
  page: { before?: string | undefined; limit: number },
): Promise<ReviewedRow[]> {
  let q = db
    .selectFrom("reviews")
    .innerJoin("cases", "cases.id", "reviews.case_id")
    .innerJoin("interactions", "interactions.id", "cases.interaction_id")
    .leftJoin("classifications", "classifications.id", "cases.classification_id")
    .select([
      "reviews.id",
      "reviews.case_id",
      "reviews.reviewer",
      "reviews.decision",
      "reviews.corrected_intent",
      "reviews.corrected_team",
      "reviews.note",
      "reviews.spot_check",
      "reviews.reviewed_at",
      "interactions.external_id",
      "cases.target_team",
      "cases.needs_review",
      "classifications.intent",
    ]);
  if (filters.reviewer) q = q.where("reviews.reviewer", "=", filters.reviewer);
  if (filters.decision) q = q.where("reviews.decision", "=", filters.decision);
  if (page.before) q = q.where("reviews.id", "<", page.before);
  const rows = await q.orderBy("reviews.id", "desc").limit(page.limit).execute();

  return rows.map((r) => ({
    reviewId: r.id,
    caseId: r.case_id,
    externalId: r.external_id,
    reviewer: r.reviewer,
    decision: r.decision,
    spotCheck: r.spot_check,
    reviewedAt: r.reviewed_at,
    note: r.note,
    original: { intent: r.intent, team: r.target_team },
    effective: effectiveDecision({ targetTeam: r.target_team, needsReview: r.needs_review }, r.intent, {
      decision: r.decision,
      correctedIntent: r.corrected_intent,
      correctedTeam: r.corrected_team,
    }),
  }));
}
