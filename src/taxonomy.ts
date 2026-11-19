// The shared vocabulary of the system, fixed in P00 (see specs/phases/001-p00-*).
// Used by the dataset scripts now, and later by the P03 output schema and the P07
// routing rules. Lives at src/ root because it belongs to no single pipeline step.

export const INTENTS = [
  "billing_question",
  "technical_fault",
  "tariff_change",
  "cancellation",
  "complaint",
  "other",
] as const;
export type Intent = (typeof INTENTS)[number];

export const URGENCY = ["low", "normal", "high"] as const;
export type Urgency = (typeof URGENCY)[number];

export const TEAMS = ["billing", "technical_support", "sales", "retention", "complaints", "general"] as const;
export type Team = (typeof TEAMS)[number];

export const INTENT_TO_TEAM: Readonly<Record<Intent, Team>> = {
  billing_question: "billing",
  technical_fault: "technical_support",
  tariff_change: "sales",
  cancellation: "retention",
  complaint: "complaints",
  other: "general",
};

/**
 * When a message contains several intents, the primary one is the first in this
 * list. Consequential intents win, because they must reach review and the right team.
 */
export const INTENT_PRECEDENCE: readonly Intent[] = [
  "cancellation",
  "complaint",
  "technical_fault",
  "billing_question",
  "tariff_change",
  "other",
];

export function primaryIntent(intents: readonly Intent[]): Intent {
  for (const intent of INTENT_PRECEDENCE) {
    if (intents.includes(intent)) return intent;
  }
  return "other";
}

export const SERVICE_TYPES = ["internet", "mobile", "tv", "unknown"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const IDENTIFIER_TYPES = [
  "customer_number",
  "contract_number",
  "phone",
  "email",
  "birth_number",
  "bank_account",
  "iban",
] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

/**
 * Review reasons that can be labelled in the dataset. The runtime routing rules use their own
 * list, REASON_CODES, because a label and a reason code are different things (P07).
 */
export const REVIEW_REASONS = ["cancellation", "complaint", "unclear"] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/**
 * Reason codes the routing rules (src/pipeline/route.ts) give a case, in the order they are
 * listed on it. A case needs review exactly when it has at least one. The dataset's `unclear`
 * label has no code of its own: at runtime it is caught by `low_confidence`.
 */
export const REASON_CODES = [
  /**
   * Processing failed for good after every job attempt (P08): nothing else was decided. Written
   * only by the pipeline runner's failure path (src/db/cases.ts, recordFailureCase), never by
   * route(); it comes first because it outranks every other reason.
   */
  "processing_failed",
  "invalid_output",
  "classification_error",
  "cancellation",
  "complaint",
  "low_confidence",
  "customer_not_found",
  "customer_ambiguous",
  "customer_unidentified",
  "crm_mismatch_unmatched_key",
  "crm_mismatch_service_type",
  /** Produced from P10 (the investigating agent); never produced by route.v1 or route.v2. */
  "investigation_inconclusive",
  /**
   * Produced from P11 (route.v4): a model's output text holds an identifier, which the model
   * never saw (src/pipeline/output-check.ts).
   */
  "suspicious_output",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * Likely causes the investigating agent (P10) can return for a technical fault. Each one has
 * evidence a tool can show; `inconclusive` is the answer when the tools show none.
 */
export const LIKELY_CAUSES = [
  "area_outage",
  "line_fault",
  "customer_equipment",
  "service_inactive",
  "inconclusive",
] as const;
export type LikelyCause = (typeof LIKELY_CAUSES)[number];

/** How an investigation attempt ended (P10): only `valid` carries a cause. */
export const INVESTIGATION_OUTCOMES = ["valid", "step_limit", "invalid", "error"] as const;
export type InvestigationOutcome = (typeof INVESTIGATION_OUTCOMES)[number];

/** The mock CRM's line state per service (P10, crm_line_status). */
export const LINE_STATES = ["up", "degraded", "down"] as const;
export type LineState = (typeof LINE_STATES)[number];

/** The investigating agent's tools: read-only, and the only ones it has (P10). */
export const INVESTIGATE_TOOLS = ["check_outages", "get_line_status", "get_recent_tickets"] as const;
export type InvestigateTool = (typeof INVESTIGATE_TOOLS)[number];

export const CHANNELS = ["email", "chat", "call"] as const;
export type Channel = (typeof CHANNELS)[number];

export const LANGUAGES = ["cs", "sk", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export const REGISTERS = ["polite", "angry", "terse", "indirect"] as const;
export type Register = (typeof REGISTERS)[number];

/** Review reasons that follow from the intent alone. */
export function ruleReviewReasons(intent: Intent): ReviewReason[] {
  if (intent === "cancellation") return ["cancellation"];
  if (intent === "complaint") return ["complaint"];
  return [];
}
