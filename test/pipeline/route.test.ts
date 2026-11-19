// Routing rules (P07 requirements.md, "Routing rules"), on hand-made inputs.

import { describe, expect, it } from "vitest";
import type { Classification } from "../../src/llm/schemas/classification.schema.js";
import type { EnrichmentOutcome } from "../../src/pipeline/enrich.js";
import { route, type RouteInput } from "../../src/pipeline/route.js";
import { INTENT_TO_TEAM, INTENTS, REASON_CODES, type Intent, type ServiceType } from "../../src/taxonomy.js";

const CUSTOMER = "00000000-0000-4000-8000-000000000001";

function classification(over: Partial<Classification> = {}, fields: Partial<Classification["fields"]> = {}) {
  return {
    intent: "billing_question",
    urgency: "normal",
    language: "cs",
    summary: "Customer asks about an invoice.",
    confidence: 0.9,
    ...over,
    fields: { identifiers: [], service_type: "internet", area: null, ...fields },
  } satisfies Classification;
}

function input(
  opts: {
    intent?: Intent;
    confidence?: number;
    serviceType?: ServiceType;
    outcome?: EnrichmentOutcome;
    unmatched?: string[];
    held?: RouteInput["customerServiceTypes"];
  } = {},
): RouteInput {
  const outcome = opts.outcome ?? "found";
  return {
    outcome: "valid",
    classification: classification(
      { intent: opts.intent ?? "billing_question", confidence: opts.confidence ?? 0.9 },
      { service_type: opts.serviceType ?? "internet" },
    ),
    enrichment: {
      outcome,
      customerId: outcome === "found" ? CUSTOMER : null,
      unmatchedPlaceholders: opts.unmatched ?? [],
    },
    customerServiceTypes: opts.held ?? (outcome === "found" ? ["internet"] : []),
  };
}

describe("team", () => {
  it.each(INTENTS)("routes %s to its team", (intent) => {
    expect(route(input({ intent })).targetTeam).toBe(INTENT_TO_TEAM[intent]);
  });

  it("routes an auto-routed case without review", () => {
    expect(route(input())).toEqual({
      targetTeam: "billing",
      needsReview: false,
      reasonCodes: [],
      firedRules: [],
    });
  });

  it.each([
    ["invalid", "invalid_output"],
    ["error", "classification_error"],
  ] as const)("sends a %s classification to general with review", (outcome, code) => {
    const r = route({ outcome, classification: null, enrichment: null, customerServiceTypes: [] });
    expect(r.targetTeam).toBe("general");
    expect(r.needsReview).toBe(true);
    expect(r.reasonCodes).toEqual([code]);
  });
});

describe("review reasons", () => {
  it.each(["cancellation", "complaint"] as const)("always reviews %s", (intent) => {
    expect(route(input({ intent })).reasonCodes).toEqual([intent]);
  });

  it("reviews confidence 0.69 but not 0.7", () => {
    const low = route(input({ confidence: 0.69 }));
    expect(low.reasonCodes).toEqual(["low_confidence"]);
    expect(low.firedRules[0]!.detail).toBe("confidence 0.69 < 0.7");
    expect(route(input({ confidence: 0.7 })).needsReview).toBe(false);
  });

  it("reviews not_found and ambiguous", () => {
    expect(route(input({ outcome: "not_found" })).reasonCodes).toEqual(["customer_not_found"]);
    expect(route(input({ outcome: "ambiguous" })).reasonCodes).toEqual(["customer_ambiguous"]);
  });

  it("reviews a technical fault with no identifiers", () => {
    expect(route(input({ intent: "technical_fault", outcome: "no_identifiers" })).reasonCodes).toEqual([
      "customer_unidentified",
    ]);
  });

  it.each(["billing_question", "tariff_change", "other"] as const)(
    "routes %s with no identifiers without review",
    (intent) => {
      expect(route(input({ intent, outcome: "no_identifiers" })).needsReview).toBe(false);
    },
  );

  it.each(["cancellation", "complaint"] as const)("gives %s with no identifiers only its intent code", (intent) => {
    expect(route(input({ intent, outcome: "no_identifiers" })).reasonCodes).toEqual([intent]);
  });

  it("reviews a found customer with an unmatched key", () => {
    const r = route(input({ unmatched: ["[EMAIL_1]"] }));
    expect(r.reasonCodes).toEqual(["crm_mismatch_unmatched_key"]);
    expect(r.firedRules[0]!.detail).toBe("[EMAIL_1] matched no customer");
  });

  it("reviews a classified service type the customer doesn't hold", () => {
    const r = route(input({ serviceType: "mobile", held: ["internet", "tv"] }));
    expect(r.reasonCodes).toEqual(["crm_mismatch_service_type"]);
    expect(r.firedRules[0]!.detail).toBe(`classified mobile, customer ${CUSTOMER} has internet, tv`);
  });

  it("does not flag the service type when the customer holds it (even terminated) or it is unknown", () => {
    // customerServiceTypes includes terminated services: the caller passes all of them.
    expect(route(input({ serviceType: "mobile", held: ["mobile"] })).needsReview).toBe(false);
    expect(route(input({ serviceType: "unknown", held: ["internet"] })).needsReview).toBe(false);
  });

  it("does not check mismatches when the customer was not found", () => {
    expect(route(input({ outcome: "not_found", unmatched: ["[PHONE_1]"], serviceType: "tv" })).reasonCodes).toEqual([
      "customer_not_found",
    ]);
  });

  it("keeps every reason that applies, in REASON_CODES order", () => {
    const r = route(
      input({ intent: "complaint", confidence: 0.5, unmatched: ["[PHONE_1]"], serviceType: "tv", held: ["internet"] }),
    );
    expect(r.reasonCodes).toEqual([
      "complaint",
      "low_confidence",
      "crm_mismatch_unmatched_key",
      "crm_mismatch_service_type",
    ]);
    const order = r.reasonCodes.map((code) => REASON_CODES.indexOf(code));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(r.needsReview).toBe(true);
  });

  it("never produces investigation_inconclusive or processing_failed", () => {
    for (const intent of INTENTS) {
      for (const outcome of ["found", "not_found", "ambiguous", "no_identifiers"] as const) {
        const codes = route(input({ intent, outcome, confidence: 0.1 })).reasonCodes;
        expect(codes).not.toContain("investigation_inconclusive");
        expect(codes).not.toContain("processing_failed");
      }
    }
    for (const outcome of ["invalid", "error"] as const) {
      expect(
        route({ outcome, classification: null, enrichment: null, customerServiceTypes: [] }).reasonCodes,
      ).not.toContain("processing_failed");
    }
  });

  it("puts no identifier value in a detail", () => {
    const c = classification(
      { intent: "technical_fault", confidence: 0.4 },
      { service_type: "tv", identifiers: [{ type: "phone", value: "777 123 456" }] },
    );
    const r = route({
      outcome: "valid",
      classification: c,
      enrichment: { outcome: "found", customerId: CUSTOMER, unmatchedPlaceholders: ["[EMAIL_1]"] },
      customerServiceTypes: ["internet"],
    });
    expect(r.firedRules.length).toBe(3);
    for (const rule of r.firedRules) expect(rule.detail).not.toMatch(/777|@/);
  });
});
