// Classification attempts for tests.

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
