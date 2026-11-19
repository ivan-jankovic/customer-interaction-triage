// Step 6 of the pipeline: routing (P07 requirements.md, "Routing rules"). Plain code, no model:
// turns the stored classification and enrichment into a target team, a review flag and the
// reason codes. Decisions are made here, never in a prompt.
//
// Pure: the found customer's service types are passed in as data, so the rules are tested
// without a database and the evaluation routes its stored outputs with this same function.
// Every rule is checked and every one that applies adds its code, so a reviewer sees all the
// reasons, not only the first. A change to the threshold or the rules is a new ROUTER_VERSION.

import type { Classification } from "../llm/schemas/classification.schema.js";
import { INTENT_TO_TEAM, REASON_CODES, type Intent, type ReasonCode, type Team } from "../taxonomy.js";
import type { CrmServiceType, EnrichmentResult } from "./enrich.js";
import type { Outcome } from "./understand.js";

export const ROUTER_VERSION = "route.v1";

/**
 * Below this self-reported confidence a case goes to review. 0.7 catches every message labelled
 * `unclear` in the kept classify.v2 run (all at 0.6 or lower) with two 0.05 steps to spare.
 */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Intents that go to review when no customer can be identified. Only technical faults: they
 * can't be checked against line status or tickets without a customer, while the billing and
 * sales teams routinely ask for the account number (P07 requirements.md, Decisions).
 */
export const UNIDENTIFIED_REVIEW_INTENTS: readonly Intent[] = ["technical_fault"];

/** The team of a case whose classification gave no usable intent. */
export const FALLBACK_TEAM: Team = "general";

export interface RouteInput {
  /** The outcome of the classification attempt used (see requirements.md, "Which inputs are used"). */
  outcome: Outcome;
  /** Set exactly when the outcome is valid. */
  classification: Classification | null;
  /** The enrichment made from that classification; null when the classification isn't valid. */
  enrichment: Pick<EnrichmentResult, "outcome" | "customerId" | "unmatchedPlaceholders"> | null;
  /** Service types of the found customer, active or terminated; empty when none was found. */
  customerServiceTypes: readonly CrmServiceType[];
}

export interface FiredRule {
  reasonCode: ReasonCode;
  /** A short explanation naming placeholders and IDs only, never identifier values. */
  detail: string;
}

export interface RouteResult {
  targetTeam: Team;
  needsReview: boolean;
  /** In REASON_CODES order. */
  reasonCodes: ReasonCode[];
  firedRules: FiredRule[];
}

export function route(input: RouteInput): RouteResult {
  const fired: FiredRule[] = [];
  const add = (reasonCode: ReasonCode, detail: string) => fired.push({ reasonCode, detail });

  const c = input.outcome === "valid" ? input.classification : null;
  if (input.outcome === "invalid") add("invalid_output", "the model's output failed validation");
  if (input.outcome === "error") add("classification_error", "the classification call failed");
  if (input.outcome === "valid" && !c) add("invalid_output", "valid outcome without a classification");

  if (c) {
    if (c.intent === "cancellation") add("cancellation", "intent cancellation is always reviewed");
    if (c.intent === "complaint") add("complaint", "intent complaint is always reviewed");
    if (c.confidence < REVIEW_CONFIDENCE_THRESHOLD) {
      add("low_confidence", `confidence ${c.confidence} < ${REVIEW_CONFIDENCE_THRESHOLD}`);
    }

    const e = input.enrichment;
    if (e?.outcome === "not_found") add("customer_not_found", "no customer matched the message's keys");
    if (e?.outcome === "ambiguous") add("customer_ambiguous", "the message's keys matched several customers");
    if (e?.outcome === "no_identifiers" && UNIDENTIFIED_REVIEW_INTENTS.includes(c.intent)) {
      add("customer_unidentified", `intent ${c.intent} with no account identifiers`);
    }
    if (e?.outcome === "found" && e.unmatchedPlaceholders.length > 0) {
      add("crm_mismatch_unmatched_key", `${e.unmatchedPlaceholders.join(", ")} matched no customer`);
    }
    const type = c.fields.service_type;
    if (e?.outcome === "found" && type !== "unknown" && !input.customerServiceTypes.includes(type)) {
      const held = [...new Set(input.customerServiceTypes)].sort().join(", ") || "none";
      add("crm_mismatch_service_type", `classified ${type}, customer ${e.customerId} has ${held}`);
    }
  }

  fired.sort((a, b) => REASON_CODES.indexOf(a.reasonCode) - REASON_CODES.indexOf(b.reasonCode));
  return {
    targetTeam: c ? INTENT_TO_TEAM[c.intent] : FALLBACK_TEAM,
    needsReview: fired.length > 0,
    reasonCodes: fired.map((f) => f.reasonCode),
    firedRules: fired,
  };
}
