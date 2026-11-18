import { describe, expect, it } from "vitest";
import { labelRuleErrors, recordErrors, validateGraderOutputSchema, validateLabelsSchema } from "../../eval/schema/validate.js";
import { labels, record } from "./fixtures.js";

describe("labels schema", () => {
  it("accepts valid labels", () => {
    expect(validateLabelsSchema(labels())).toBe(true);
  });

  it("rejects unknown intents, extra fields and bad identifier types", () => {
    expect(validateLabelsSchema(labels({ intent: "refund" as never }))).toBe(false);
    expect(validateLabelsSchema({ ...labels(), extra: 1 })).toBe(false);
    expect(
      validateLabelsSchema(labels({ fields: { identifiers: [{ type: "passport" as never, value: "x" }], service_type: "tv", area: null } })),
    ).toBe(false);
  });

  it("accepts a null area", () => {
    expect(validateLabelsSchema(labels({ fields: { identifiers: [], service_type: "unknown", area: null } }))).toBe(true);
  });
});

describe("grader output schema", () => {
  it("accepts a complete grader answer and rejects a partial one", () => {
    const answer = {
      intent: "complaint",
      urgency: "normal",
      must_review: true,
      review_reasons: ["complaint"],
      service_type: "mobile",
      area: null,
      rationale: "Formal complaint about a charge.",
    };
    expect(validateGraderOutputSchema(answer)).toBe(true);
    const { rationale: _omit, ...partial } = answer;
    expect(validateGraderOutputSchema(partial)).toBe(false);
  });
});

describe("label rules", () => {
  it("requires the team to follow the intent", () => {
    expect(labelRuleErrors(labels({ expected_team: "billing" }))).toEqual([
      "expected_team billing does not match intent technical_fault",
    ]);
  });

  it("requires review for cancellations and complaints", () => {
    expect(labelRuleErrors(labels({ intent: "cancellation", expected_team: "retention" }))).toEqual([
      "intent cancellation requires review reason cancellation",
    ]);
    expect(
      labelRuleErrors(
        labels({ intent: "complaint", expected_team: "complaints", must_review: false, review_reasons: ["complaint"] }),
      ),
    ).toEqual(["must_review must be true exactly when review_reasons is non-empty"]);
  });

  it("accepts unclear as a judgement reason on any intent", () => {
    expect(labelRuleErrors(labels({ must_review: true, review_reasons: ["unclear"] }))).toEqual([]);
  });

  it("rejects an intent-specific reason on the wrong intent", () => {
    expect(labelRuleErrors(labels({ must_review: true, review_reasons: ["complaint"] }))).toEqual([
      "review reason complaint does not match intent technical_fault",
    ]);
  });
});

describe("record validation", () => {
  it("accepts a valid record", () => {
    expect(recordErrors(record())).toEqual([]);
  });

  it("requires attack exactly on injection records", () => {
    expect(recordErrors(record({ attack: { tactic: "direct_instruction", goal: "reroute" } }))).toEqual([
      "attack must be present exactly on injection records (inj-*)",
    ]);
    expect(recordErrors(record({ id: "inj-001" }))).toEqual(["attack must be present exactly on injection records (inj-*)"]);
  });

  it("checks rules on the final labels too", () => {
    expect(recordErrors(record({ final: labels({ expected_team: "sales" }) }))).toEqual([
      "final: expected_team sales does not match intent technical_fault",
    ]);
  });

  it("rejects malformed ids", () => {
    expect(recordErrors(record({ id: "message-1" })).length).toBeGreaterThan(0);
  });
});
