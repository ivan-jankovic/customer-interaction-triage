// Review actions (P09): confirm, correct and unmask a case. A review is written once per case
// (unique case_id); when two reviewers race, ON CONFLICT DO NOTHING lets one win and the other
// gets the stored review back, as with cases (P07). The case itself is never changed.
// Unmasking writes its unmask_log row before the raw text is returned, so every view is logged.

import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";
import type { Intent, Team } from "../taxonomy.js";
import { CaseNotFound, readReview, type StoredReview } from "./case-view.js";
import { parseNote, parseReason, parseReviewer, validateCorrection } from "./rules.js";

export type ReviewResult = { stored: true; review: StoredReview } | { stored: false; existing: StoredReview };

/** A review input that failed the rules (bad handle, missing note, a correction that changes nothing). */
export class InvalidReview extends Error {}

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new InvalidReview(r.error);
  return r.value;
};

async function caseFacts(db: Kysely<Database>, caseId: string) {
  const c = await db
    .selectFrom("cases")
    .leftJoin("classifications", "classifications.id", "cases.classification_id")
    .select(["cases.id", "cases.target_team", "cases.needs_review", "classifications.intent"])
    .where("cases.id", "=", caseId)
    .executeTakeFirst();
  if (!c) throw new CaseNotFound(`No case ${caseId}.`);
  return c;
}

async function insertReview(
  db: Kysely<Database>,
  values: {
    case_id: string;
    reviewer: string;
    decision: "confirmed" | "corrected";
    corrected_intent: Intent | null;
    corrected_team: Team | null;
    note: string | null;
    spot_check: boolean;
  },
): Promise<ReviewResult> {
  const inserted = await db
    .insertInto("reviews")
    .values(values)
    .onConflict((oc) => oc.column("case_id").doNothing())
    .returning("id")
    .executeTakeFirst();
  const review = (await readReview(db, values.case_id))!;
  return inserted ? { stored: true, review } : { stored: false, existing: review };
}

export async function confirmCase(
  db: Kysely<Database>,
  caseId: string,
  input: { reviewer: string; note?: string | undefined },
): Promise<ReviewResult> {
  const reviewer = unwrap(parseReviewer(input.reviewer));
  const note = unwrap(parseNote(input.note));
  const c = await caseFacts(db, caseId);
  return insertReview(db, {
    case_id: caseId,
    reviewer,
    decision: "confirmed",
    corrected_intent: null,
    corrected_team: null,
    note,
    spot_check: !c.needs_review,
  });
}

export async function correctCase(
  db: Kysely<Database>,
  caseId: string,
  input: { reviewer: string; intent: Intent; team: Team; note: string | undefined },
): Promise<ReviewResult> {
  const reviewer = unwrap(parseReviewer(input.reviewer));
  const c = await caseFacts(db, caseId);
  // Only a valid classification has an intent; for invalid ones the column is null.
  const correction = unwrap(
    validateCorrection({
      caseIntent: c.intent,
      caseTeam: c.target_team,
      intent: input.intent,
      team: input.team,
      note: input.note,
    }),
  );
  return insertReview(db, {
    case_id: caseId,
    reviewer,
    decision: "corrected",
    corrected_intent: correction.intent,
    corrected_team: correction.team,
    note: correction.note,
    spot_check: !c.needs_review,
  });
}

/** Logs the view, then returns the message's raw text. */
export async function unmaskCase(
  db: Kysely<Database>,
  caseId: string,
  input: { reviewer: string; reason: string | undefined },
): Promise<string> {
  const reviewer = unwrap(parseReviewer(input.reviewer));
  const reason = unwrap(parseReason(input.reason));
  const c = await db.selectFrom("cases").select("interaction_id").where("id", "=", caseId).executeTakeFirst();
  if (!c) throw new CaseNotFound(`No case ${caseId}.`);
  await db.insertInto("unmask_log").values({ case_id: caseId, reviewer, reason }).execute();
  const i = await db
    .selectFrom("interactions")
    .select("raw_text")
    .where("id", "=", c.interaction_id)
    .executeTakeFirstOrThrow();
  return i.raw_text;
}
