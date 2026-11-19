// The review queue (P09 requirements.md, "The review loop"): unreviewed cases, oldest first.
// By default the cases that need review; with spotCheck the auto-routed ones. The queue is read
// again before each case, so a case another reviewer finished meanwhile is not shown.

import { sql, type Kysely } from "kysely";
import type { Database } from "../db/database.js";
import type { ReasonCode, Team } from "../taxonomy.js";

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
