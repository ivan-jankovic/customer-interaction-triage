// The output check (P11 requirements.md, "Hardening") and route.v4's suspicious_output rule.

import { describe, expect, it } from "vitest";
import type { Classification } from "../../src/llm/schemas/classification.schema.js";
import { findIdentifiersInOutput } from "../../src/pipeline/output-check.js";
import { route, type InvestigationSummary, type RouteInput } from "../../src/pipeline/route.js";

const CUSTOMER = "00000000-0000-4000-8000-000000000001";

function input(summary: string, investigation: InvestigationSummary | null = null): RouteInput {
  const intent = investigation ? "technical_fault" : "billing_question";
  return {
    outcome: "valid",
    classification: {
      intent,
      urgency: "normal",
      language: "cs",
      summary,
      confidence: 0.9,
      fields: { identifiers: [], service_type: "internet", area: null },
    } satisfies Classification,
    enrichment: { outcome: "found", customerId: CUSTOMER, unmatchedPlaceholders: [] },
    customerServiceTypes: ["internet"],
    investigation,
  };
}

const conclusive = (over: Partial<InvestigationSummary> = {}): InvestigationSummary => ({
  outcome: "valid",
  likelyCause: "line_fault",
  confidence: 0.9,
  summary: "The customer's line is down with no outage in the area.",
  evidence: [{ finding: "Service down since 06:10." }],
  ...over,
});

describe("findIdentifiersInOutput", () => {
  it.each([
    ["phone", "Customer at +420 601 123 456 asks about the invoice."],
    ["phone", "Call back on 601123456 today."],
    ["email", "Send the copy to jana.k@example.net."],
    ["customer_number", "Customer MR12345678 asks about the invoice."],
    ["contract_number", "Contract SML-2024-00123 should end."],
    ["iban", "Refund to CZ65 0800 0000 1920 0014 5399."],
  ])("finds a %s", (type, text) => {
    expect(findIdentifiersInOutput([{ output: "classification summary", text }])).toEqual([
      { output: "classification summary", types: [type] },
    ]);
  });

  it.each([
    "Customer [CUSTOMER_NUMBER_1] asks about the invoice for [PHONE_1].",
    "Customer asks why the invoice rose from 600 to 900 CZK; due in 10 days.",
    "The customer writes to podpora@merelo.example about a refund.",
    "Line down since 2026-11-06 07:50; outage 3 hours old.",
  ])("finds nothing in %j", (text) => {
    expect(findIdentifiersInOutput([{ output: "classification summary", text }])).toEqual([]);
  });

  it("names each output with its own types, and skips missing texts", () => {
    expect(
      findIdentifiersInOutput([
        { output: "classification summary", text: "Clean." },
        { output: "investigation summary", text: null },
        { output: "evidence 2", text: "Number 601123456 and MR12345678, again 601 123 456." },
      ]),
    ).toEqual([{ output: "evidence 2", types: ["phone", "customer_number"] }]);
  });
});

describe("suspicious_output (route.v4)", () => {
  it("fires for an identifier in the classification summary, naming only the type", () => {
    const r = route(input("Customer +420 601 123 456 asks about the invoice."));
    expect(r.reasonCodes).toEqual(["suspicious_output"]);
    expect(r.needsReview).toBe(true);
    expect(r.targetTeam).toBe("billing");
    expect(r.firedRules[0]!.detail).toBe("phone in the classification summary");
    expect(r.firedRules[0]!.detail).not.toContain("601");
  });

  it("fires for an identifier in the investigation summary or a finding, without changing the team", () => {
    const inSummary = route(input("Clean.", conclusive({ summary: "Line of MR12345678 is down." })));
    expect(inSummary.reasonCodes).toEqual(["suspicious_output"]);
    expect(inSummary.targetTeam).toBe("technical_support");
    const inFinding = route(
      input("Clean.", conclusive({ evidence: [{ finding: "ok" }, { finding: "SIM 601123456 down." }] })),
    );
    expect(inFinding.firedRules).toEqual([{ reasonCode: "suspicious_output", detail: "phone in the evidence 2" }]);
  });

  it("adds nothing when every output is clean, as route.v3", () => {
    expect(route(input("Customer [PHONE_1] asks about the invoice.")).reasonCodes).toEqual([]);
    expect(route(input("Clean.", conclusive())).reasonCodes).toEqual([]);
  });

  it("keeps the other reasons next to it", () => {
    const i = input("Cancel for [PHONE_1], call 601123456 today.");
    i.classification!.intent = "cancellation";
    expect(route(i).reasonCodes).toEqual(["cancellation", "suspicious_output"]);
  });
});
