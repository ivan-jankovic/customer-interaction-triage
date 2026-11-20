// The review queue (P09 requirements.md, "The review loop"): unreviewed cases, oldest first.
// By default the cases that need review; with spotCheck the auto-routed ones. The queue is read
// again before each case, so a case another reviewer finished meanwhile is not shown.

import { sql, type Kysely } from "kysely";
import type { Database } from "../db/database.js";
import type { Channel, Intent, Language, ReasonCode, Team } from "../taxonomy.js";

export interface QueueFilters {
  /** Auto-routed cases (no review needed) instead of the ones that need review. */
  spotCheck?: boolean;
  team?: Team | undefined;
  reason?: ReasonCode | undefined;
  /** Case IDs to leave out (the session's skipped cases). */
  exclude?: readonly string[];
}

function queueQuery(db: Kysely<Database>, f: QueueFilters) {
  let q = db
    .selectFrom("cases")
    .where("needs_review", "=", !f.spotCheck)
    .where((eb) =>
      eb.not(eb.exists(eb.selectFrom("reviews").select("reviews.id").whereRef("reviews.case_id", "=", "cases.id"))),
    );
  if (f.team) q = q.where("target_team", "=", f.team);
  // jsonb containment: the case's reason codes include this one.
  if (f.reason) q = q.where(sql<boolean>`reason_codes @> ${JSON.stringify([f.reason])}::jsonb`);
  if (f.exclude?.length) q = q.where("cases.id", "not in", [...f.exclude]);
  return q;
}

/** The oldest unreviewed case matching the filters, or null when the queue is empty. */
export async function nextCase(db: Kysely<Database>, filters: QueueFilters = {}): Promise<string | null> {
  const row = await queueQuery(db, filters).select("cases.id").orderBy("cases.id").limit(1).executeTakeFirst();
  return row?.id ?? null;
}

/** How many unreviewed cases match the filters (skipped ones included unless excluded). */
export async function queueSize(db: Kysely<Database>, filters: QueueFilters = {}): Promise<number> {
  const row = await queueQuery(db, filters)
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** One row of the web page's queue list (P13). No message text and no identifier values. */
export interface QueueRow {
  caseId: string;
  interactionId: string;
  externalId: string | null;
  receivedAt: Date;
  channel: Channel;
  language: Language | null;
  /** Null when there is no classification (a failure case before classifying). */
  outcome: "valid" | "invalid" | "error" | null;
  intent: Intent | null;
  confidence: number | null;
  targetTeam: Team;
  reasonCodes: ReasonCode[];
}

/**
 * A page of the queue, oldest first, for the web page's list (P13). `after` is the last case ID
 * of the previous page (case IDs are time-ordered uuidv7, as nextCase's order relies on).
 */
export async function listQueue(
  db: Kysely<Database>,
  filters: QueueFilters,
  page: { after?: string | undefined; limit: number },
): Promise<QueueRow[]> {
  let q = queueQuery(db, filters)
    .innerJoin("interactions", "interactions.id", "cases.interaction_id")
    .leftJoin("classifications", "classifications.id", "cases.classification_id")
    .select([
      "cases.id as caseId",
      "cases.interaction_id as interactionId",
      "interactions.external_id as externalId",
      "interactions.received_at as receivedAt",
      "interactions.channel",
      "interactions.language",
      "classifications.outcome",
      "classifications.intent",
      "classifications.confidence",
      "cases.target_team as targetTeam",
      "cases.reason_codes as reasonCodes",
    ]);
  if (page.after) q = q.where("cases.id", ">", page.after);
  return q.orderBy("cases.id").limit(page.limit).execute();
}

/**
 * A case's place in the queue ("3 of 41") for the web page: the queue cases up to and including
 * it, out of all of them. Null when the case isn't in this queue (reviewed, or the other kind).
 */
export async function queuePosition(
  db: Kysely<Database>,
  filters: QueueFilters,
  caseId: string,
): Promise<{ index: number; total: number } | null> {
  const inQueue = await queueQuery(db, filters).select("cases.id").where("cases.id", "=", caseId).executeTakeFirst();
  if (!inQueue) return null;
  const upTo = await queueQuery(db, filters)
    .where("cases.id", "<=", caseId)
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .executeTakeFirstOrThrow();
  return { index: Number(upTo.n), total: await queueSize(db, filters) };
}
