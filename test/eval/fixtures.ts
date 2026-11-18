import type { DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import type { Labels } from "../../eval/schema/labels.schema.js";

export function labels(overrides: Partial<Labels> = {}): Labels {
  return {
    intent: "technical_fault",
    urgency: "high",
    must_review: false,
    review_reasons: [],
    expected_team: "technical_support",
    fields: {
      identifiers: [{ type: "customer_number", value: "MR40218837" }],
      service_type: "internet",
      area: "Olomouc",
    },
    ...overrides,
  };
}

export function record(overrides: Partial<DatasetRecord> = {}): DatasetRecord {
  return {
    id: "msg-001",
    channel: "email",
    language: "cs",
    text: "Dobrý den, od rána mi nejde internet. Zákaznické číslo MR40218837, Olomouc.",
    plan: { register: "terse", designed_ambiguous: false, mixed_language: false, attempt: 1 },
    chosen: labels(),
    graders: [],
    final: null,
    review: { needed: false, sampled: false, reviewed: false, outcome: null, changed_fields: [], note: null },
    generation: { model: "claude-opus-5-5", prompt_version: "generate.v1" },
    ...overrides,
  };
}
