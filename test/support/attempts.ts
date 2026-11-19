// Classification attempts for tests.

import type { InvestigationAttempt } from "../../src/pipeline/investigate.js";
import type { ClassificationAttempt } from "../../src/pipeline/understand.js";

export const VALID_CLASSIFICATION = {
  intent: "technical_fault",
  urgency: "high",
  language: "cs",
  fields: {
    identifiers: [{ type: "customer_number", value: "MR11112222" }],
    service_type: "internet",
    area: "Kolín",
  },
  summary: "Customer has had no internet since this morning.",
  confidence: 0.9,
} as const satisfies NonNullable<ClassificationAttempt["classification"]>;

export function attempt(overrides: Partial<ClassificationAttempt> = {}): ClassificationAttempt {
  return {
    outcome: "valid",
    classification: VALID_CLASSIFICATION,
    rawOutput: JSON.stringify(VALID_CLASSIFICATION),
    errors: [],
    promptVersion: "classify.v1",
    requestedModel: "claude-opus-5-5",
    servedModel: "claude-opus-5-5",
    fellBack: false,
    effort: "low",
    usage: { input_tokens: 200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 },
    costUsd: 0.008,
    latencyMs: 2100,
    ...overrides,
  };
}

export const invalidAttempt = (overrides: Partial<ClassificationAttempt> = {}) =>
  attempt({
    outcome: "invalid",
    classification: null,
    rawOutput: "not json {",
    errors: ["not valid JSON"],
    ...overrides,
  });

export const errorAttempt = (overrides: Partial<ClassificationAttempt> = {}) =>
  attempt({
    outcome: "error",
    classification: null,
    rawOutput: null,
    errors: ["API error 529: overloaded"],
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    costUsd: 0,
    ...overrides,
  });

/** An investigation attempt for tests (P10): conclusive by default, with one tool call. */
export function investigationAttempt(overrides: Partial<InvestigationAttempt> = {}): InvestigationAttempt {
  return {
    outcome: "valid",
    likelyCause: "area_outage",
    confidence: 0.9,
    summary: "An outage covers the area.",
    evidence: [{ tool: "check_outages", finding: "An ongoing outage in the area." }],
    steps: 2,
    toolCalls: [
      {
        turn: 1,
        tool: "check_outages",
        input: { area: "Opava" },
        result: '{"outages":[{"id":"o1","description":"TOOL-RESULT-TEXT"}]}',
        is_error: false,
        latency_ms: 3,
      },
    ],
    rawOutput: '{"likely_cause":"area_outage"}',
    errors: [],
    promptVersion: "investigate.v1",
    requestedModel: "claude-opus-5-5",
    servedModel: "claude-opus-5-5",
    effort: "low",
    usage: { input_tokens: 2000, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 6000 },
    costUsd: 0.0184,
    latencyMs: 4200,
    ...overrides,
  };
}

export const inconclusiveInvestigation = (overrides: Partial<InvestigationAttempt> = {}) =>
  investigationAttempt({ likelyCause: "inconclusive", confidence: 0.5, evidence: [], ...overrides });

export const failedInvestigation = (overrides: Partial<InvestigationAttempt> = {}) =>
  investigationAttempt({
    outcome: "error",
    likelyCause: null,
    confidence: null,
    summary: null,
    evidence: [],
    steps: 1,
    toolCalls: [],
    rawOutput: null,
    errors: ["API error 529: overloaded"],
    apiStatus: 529,
    ...overrides,
  });
