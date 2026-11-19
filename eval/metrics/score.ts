// Scores one message's classification against its final labels (P04 requirements.md, Metrics),
// and its routing decision against the labelled team and must-review flag (P07).

import type { RouteResult } from "../../src/pipeline/route.js";
import type { ClassificationAttempt } from "../../src/pipeline/understand.js";
import type { Intent, Language, ReasonCode, ReviewReason, Team } from "../../src/taxonomy.js";
import { normaliseArea } from "../dataset/mismatch.js";
import type { Labels } from "../schema/labels.schema.js";

export interface MessageScore {
  id: string;
  /** The message's labelled language, used for the per-language breakdown. */
  language: Language;
  labelIntent: Intent;
  /** "invalid" when the attempt was invalid or failed. */
  predictedIntent: Intent | "invalid";
  valid: boolean;
  intent: boolean;
  urgency: boolean;
  languageCorrect: boolean;
  serviceType: boolean;
  area: boolean;
  identifiers: { tp: number; fp: number; fn: number; exact: boolean };
  confidence: number | null;
  summary: string | null;
  routing: RoutingScore;
}

/** The routing decision (route.v1, computed by eval/lib/route-message.ts) against the labels. */
export interface RoutingScore {
  labelTeam: Team;
  predictedTeam: Team;
  team: boolean;
  labelMustReview: boolean;
  needsReview: boolean;
  labelReasons: ReviewReason[];
  reasonCodes: ReasonCode[];
}

const key = (i: { type: string; value: string }) => `${i.type}\u0000${i.value}`;

/** Multiset comparison of (type, value) pairs, values compared exactly as written. */
export function compareIdentifiers(
  expected: readonly { type: string; value: string }[],
  predicted: readonly { type: string; value: string }[],
): { tp: number; fp: number; fn: number; exact: boolean } {
  const remaining = new Map<string, number>();
  for (const e of expected) remaining.set(key(e), (remaining.get(key(e)) ?? 0) + 1);
  let tp = 0;
  for (const p of predicted) {
    const left = remaining.get(key(p)) ?? 0;
    if (left > 0) {
      tp++;
      remaining.set(key(p), left - 1);
    }
  }
  const fp = predicted.length - tp;
  const fn = expected.length - tp;
  return { tp, fp, fn, exact: fp === 0 && fn === 0 };
}

export function scoreMessage(
  id: string,
  language: Language,
  labels: Labels,
  attempt: ClassificationAttempt,
  routed: Pick<RouteResult, "targetTeam" | "needsReview" | "reasonCodes">,
): MessageScore {
  const c = attempt.outcome === "valid" ? attempt.classification : null;
  const expectedIds = labels.fields.identifiers;
  // An invalid attempt found no identifiers: every expected one is missed, and its list never
  // counts as exactly right, even when the message has no identifiers.
  const ids = compareIdentifiers(expectedIds, c?.fields.identifiers ?? []);
  return {
    id,
    language,
    labelIntent: labels.intent,
    predictedIntent: c ? c.intent : "invalid",
    valid: c !== null,
    intent: c?.intent === labels.intent,
    urgency: c?.urgency === labels.urgency,
    languageCorrect: c?.language === language,
    serviceType: c?.fields.service_type === labels.fields.service_type,
    area: c !== null && normaliseArea(c.fields.area) === normaliseArea(labels.fields.area),
    identifiers: { ...ids, exact: c !== null && ids.exact },
    confidence: c?.confidence ?? null,
    summary: c?.summary ?? null,
    routing: {
      labelTeam: labels.expected_team,
      predictedTeam: routed.targetTeam,
      team: routed.targetTeam === labels.expected_team,
      labelMustReview: labels.must_review,
      needsReview: routed.needsReview,
      labelReasons: [...labels.review_reasons],
      reasonCodes: [...routed.reasonCodes],
    },
  };
}
