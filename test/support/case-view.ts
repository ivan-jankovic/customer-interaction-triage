// A hand-built case view (P09) shared by the CLI screen and web page tests: no database.

import type { CaseView } from "../../src/review/case-view.js";

export const T = new Date("2026-11-17T07:30:00.000Z");
export const CUSTOMER = "0190e9a0-0000-7000-8000-00000000c001";

export function view(overrides: Partial<CaseView> = {}): CaseView {
  return {
    case: {
      id: "case-1",
      interactionId: "int-1",
      classificationId: "cl-1",
      enrichmentId: "en-1",
      customerId: CUSTOMER,
      targetTeam: "billing",
      needsReview: true,
      reasonCodes: ["crm_mismatch_unmatched_key"],
      routerVersion: "route.v2",
      createdAt: T,
      log: [
        {
          seq: 1,
          step: "mask",
          inputSummary: {},
          output: { placeholders: { phone: ["[PHONE_1]"] } },
          ruleApplied: "mask.v1",
          createdAt: T,
        },
        {
          seq: 2,
          step: "route",
          inputSummary: {},
          output: {
            target_team: "billing",
            needs_review: true,
            fired_rules: [{ reason_code: "crm_mismatch_unmatched_key", detail: "[EMAIL_1] matched no customer" }],
          },
          ruleApplied: "route.v2",
          createdAt: T,
        },
      ],
    },
    interaction: {
      id: "int-1",
      externalId: "msg-008",
      channel: "email",
      language: "cs",
      receivedAt: T,
      maskedText: "Dobrý den,\nvolám z [PHONE_1], e-mail [EMAIL_1].",
    },
    classification: {
      id: "cl-1",
      outcome: "valid",
      intent: "billing_question",
      urgency: "normal",
      confidence: 0.86,
      serviceType: "internet",
      area: "Kolín",
      summary: "Customer asks why the invoice is higher.",
      errors: [],
      promptVersion: "classify.v2",
      servedModel: "claude-opus-5-5",
    },
    enrichment: {
      id: "en-1",
      interactionId: "int-1",
      classificationId: "cl-1",
      enricherVersion: "enrich.v1",
      createdAt: T,
      outcome: "found",
      customerId: CUSTOMER,
      candidates: [{ customerId: CUSTOMER, placeholders: ["[PHONE_1]"] }],
      unmatchedPlaceholders: ["[EMAIL_1]"],
      area: "Kolín",
      areaSource: "message",
      outageIds: [],
    },
    customer: {
      id: CUSTOMER,
      segment: "residential",
      services: [{ service_type: "internet", tariff: "Fiber 300", area: "Kolín", status: "active" }],
    },
    outages: [],
    investigation: null,
    review: null,
    unmaskings: [],
    ...overrides,
  };
}

/** A fault's valid investigation (P10). */
export const INVESTIGATION = {
  id: "inv-1",
  outcome: "valid",
  likelyCause: "line_fault",
  confidence: 0.85,
  summary: "The customer's mobile line is down with no outage in Žilina.",
  evidence: [
    { tool: "get_line_status", finding: "Mobile line down since 2026-11-04 18:00." },
    { tool: "check_outages", finding: "No outage in Žilina." },
  ],
  errors: [],
  steps: 2,
  toolCalls: [
    { turn: 1, tool: "check_outages", input: { area: "Žilina", service_type: "mobile" }, is_error: false },
    { turn: 1, tool: "get_line_status", input: { customer_id: CUSTOMER }, is_error: false },
    { turn: 1, tool: "get_recent_tickets", input: { customer_id: "someone-else" }, is_error: true },
  ],
  servedModel: "claude-opus-5-5",
};
