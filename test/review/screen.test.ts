// The review screen's layout (P09) from hand-built case views: no database.

import { describe, expect, it } from "vitest";
import type { CaseView } from "../../src/review/case-view.js";
import { intentMenu, pick, renderCase, teamMenu } from "../../src/review/screen.js";
import { INTENTS } from "../../src/taxonomy.js";

const T = new Date("2026-11-17T07:30:00.000Z");
const CUSTOMER = "0190e9a0-0000-7000-8000-00000000c001";

function view(overrides: Partial<CaseView> = {}): CaseView {
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
    review: null,
    unmaskings: [],
    ...overrides,
  };
}

describe("renderCase", () => {
  it("shows the position, decision, reasons, classification, masked text, evidence and log", () => {
    const text = renderCase(view(), { index: 3, total: 41 }).join("\n");
    expect(text).toContain("Case 3 of 41  case-1");
    expect(text).toContain("Interaction int-1 (msg-008): email, cs, received 2026-11-17T07:30:00.000Z");
    expect(text).toContain("Team: billing    Review: needed");
    expect(text).toContain("  - crm_mismatch_unmatched_key: [EMAIL_1] matched no customer");
    expect(text).toContain(
      "Classification: intent billing_question (confidence 0.86), urgency normal, service internet, area Kolín",
    );
    expect(text).toContain("Summary: Customer asks why the invoice is higher.");
    expect(text).toContain("Message (masked):\n  Dobrý den,\n  volám z [PHONE_1], e-mail [EMAIL_1].");
    expect(text).toContain(`Customer ${CUSTOMER} (residential), matched by [PHONE_1]`);
    expect(text).toContain("internet, Fiber 300, Kolín, active");
    expect(text).toContain("Not in the CRM: [EMAIL_1]");
    expect(text).toContain("Outages: none when the message arrived");
    expect(text).toMatch(/1\. mask +\(mask\.v1\) placeholders: \[PHONE_1\]/);
    expect(text).not.toContain("Unmasked before");
  });

  it("marks a spot check and lists earlier unmaskings", () => {
    const v = view({ unmaskings: [{ reviewer: "reviewer-2", reason: "call back", unmaskedAt: T }] });
    v.case = { ...v.case, needsReview: false };
    const text = renderCase(v, { index: 1, total: 1 }).join("\n");
    expect(text).toContain("Review: not needed (auto-routed; spot check)");
    expect(text).toContain("Unmasked before:\n  reviewer-2 at 2026-11-17T07:30:00.000Z: call back");
  });

  it("shows ambiguous candidates", () => {
    const v = view({ customer: null });
    v.enrichment = {
      ...v.enrichment!,
      outcome: "ambiguous",
      customerId: null,
      candidates: [
        { customerId: "c-a", placeholders: ["[PHONE_1]"] },
        { customerId: "c-b", placeholders: ["[EMAIL_1]"] },
      ],
    };
    const text = renderCase(v, { index: 1, total: 1 }).join("\n");
    expect(text).toContain(
      "Customer lookup: ambiguous\n  Candidates:\n    customer c-a, matched by [PHONE_1]\n    customer c-b",
    );
  });

  it("says what is missing on a failure case", () => {
    const v = view({ classification: null, enrichment: null, customer: null });
    v.interaction = { ...v.interaction, maskedText: null };
    const text = renderCase(v, { index: 1, total: 1 }).join("\n");
    expect(text).toContain("Classification: none (processing failed before classifying)");
    expect(text).toContain("Message: not masked (processing failed at masking); [u]nmask shows the raw text.");
    expect(text).toContain("Customer lookup: not run");
  });

  it("shows an invalid classification's errors", () => {
    const v = view();
    v.classification = { ...v.classification!, outcome: "invalid", intent: null, errors: ["not valid JSON"] };
    expect(renderCase(v, { index: 1, total: 1 }).join("\n")).toContain(
      "Classification: invalid (classify.v2 / claude-opus-5-5): not valid JSON",
    );
  });
});

describe("menus", () => {
  it("numbers the intents and teams and marks current and default", () => {
    expect(intentMenu("billing_question")).toHaveLength(INTENTS.length);
    expect(intentMenu("billing_question")[0]).toBe("  1. billing_question  (current)");
    expect(teamMenu("billing", "retention")).toContain("  4. retention  (default)");
    expect(teamMenu("billing", "retention")[0]).toBe("  1. billing  (current)");
  });

  it("picks by number only", () => {
    expect(pick(INTENTS, " 4 ")).toBe("cancellation");
    expect(pick(INTENTS, "0")).toBeNull();
    expect(pick(INTENTS, "7")).toBeNull();
    expect(pick(INTENTS, "cancellation")).toBeNull();
  });
});
