import { describe, expect, it } from "vitest";
import { IDENTIFIER_TYPES, INTENTS, LANGUAGES, INTENT_PRECEDENCE } from "../../src/taxonomy.js";
import { INJECTION_TACTICS } from "../../eval/schema/dataset-record.schema.js";
import { labelRuleErrors, validateLabelsSchema } from "../../eval/schema/validate.js";
import { IDENTIFIER_PATTERNS } from "../../eval/dataset/identifiers.js";
import { buildPlan, TARGETS } from "../../eval/dataset/plan.js";

const { dataset, injection } = buildPlan();

describe("dataset plan", () => {
  it("is deterministic for a seed and differs across seeds", () => {
    expect(buildPlan()).toEqual(buildPlan());
    expect(buildPlan(1)).not.toEqual(buildPlan(2));
  });

  it("has unique ids", () => {
    const ids = [...dataset, ...injection].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("meets the language and channel totals exactly", () => {
    expect(dataset).toHaveLength(TARGETS.total);
    for (const language of LANGUAGES) {
      expect(dataset.filter((e) => e.language === language)).toHaveLength(TARGETS.languages[language]);
    }
    for (const [channel, n] of Object.entries(TARGETS.channels)) {
      expect(dataset.filter((e) => e.channel === channel)).toHaveLength(n);
    }
  });

  it("covers every intent at least twice per language", () => {
    for (const language of LANGUAGES) {
      for (const intent of INTENTS) {
        const n = dataset.filter((e) => e.language === language && e.chosen.intent === intent).length;
        expect(n, `${language}/${intent}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("meets the urgency, ambiguity, mixed-language and identifier targets", () => {
    expect(dataset.filter((e) => e.chosen.urgency === "high")).toHaveLength(25);
    expect(dataset.filter((e) => e.chosen.urgency === "low")).toHaveLength(25);
    expect(dataset.filter((e) => e.designed_ambiguous)).toHaveLength(15);
    expect(dataset.filter((e) => e.mixed_language)).toHaveLength(5);
    expect(dataset.filter((e) => e.chosen.fields.identifiers.length > 0)).toHaveLength(70);
    for (const type of IDENTIFIER_TYPES) {
      const n = dataset.filter((e) => e.chosen.fields.identifiers.some((i) => i.type === type)).length;
      expect(n, type).toBeGreaterThanOrEqual(TARGETS.minPerIdentifierType);
    }
  });

  it("only gives a secondary intent of lower precedence than the primary", () => {
    for (const e of dataset.filter((x) => x.secondary_intent)) {
      expect(INTENT_PRECEDENCE.indexOf(e.secondary_intent!)).toBeGreaterThan(
        INTENT_PRECEDENCE.indexOf(e.chosen.intent),
      );
    }
  });

  it("produces labels that pass the schema and the rule check", () => {
    for (const e of [...dataset, ...injection]) {
      expect(validateLabelsSchema(e.chosen), e.id).toBe(true);
      expect(labelRuleErrors(e.chosen), e.id).toEqual([]);
    }
  });

  it("uses only fictional identifier formats", () => {
    for (const e of [...dataset, ...injection]) {
      for (const id of e.chosen.fields.identifiers) expect(id.value).toMatch(IDENTIFIER_PATTERNS[id.type]);
    }
  });

  it("plans 15 injection entries covering every tactic and language", () => {
    expect(injection).toHaveLength(TARGETS.injection.total);
    expect(new Set(injection.map((e) => e.attack!.tactic))).toEqual(new Set(INJECTION_TACTICS));
    expect(new Set(injection.map((e) => e.language))).toEqual(new Set(LANGUAGES));
    for (const e of injection.filter((x) => x.attack!.tactic === "review_bypass")) {
      expect(e.chosen.must_review).toBe(true);
    }
  });
});
