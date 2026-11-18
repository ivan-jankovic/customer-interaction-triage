// Review decisions are appended to eval/data/.work/review-log.jsonl, one line per
// decision, so a review session can stop and resume at any point.

import type { Labels } from "../schema/labels.schema.js";

export type ReviewOutcome = "accepted" | "corrected" | "rewrite_requested";

export interface ReviewLogEntry {
  id: string;
  /** Generation attempt the decision applies to; a rewrite makes older decisions stale. */
  attempt: number;
  outcome: ReviewOutcome;
  /** Final labels for accepted/corrected; null for a rewrite request. */
  final: Labels | null;
  changed_fields: string[];
  note: string | null;
  reviewed_at: string;
}
