import { describe, expect, it } from "vitest";
import {
  INTENTS,
  INTENT_PRECEDENCE,
  INTENT_TO_TEAM,
  TEAMS,
  URGENCY,
  primaryIntent,
  ruleReviewReasons,
} from "../src/taxonomy.js";

describe("taxonomy", () => {
  it("has exactly the six intents, three urgency levels and six teams", () => {
    expect([...INTENTS]).toEqual([
      "billing_question",
      "technical_fault",
      "tariff_change",
      "cancellation",
      "complaint",
      "other",
    ]);
    expect([...URGENCY]).toEqual(["low", "normal", "high"]);
    expect([...TEAMS]).toEqual(["billing", "technical_support", "sales", "retention", "complaints", "general"]);
  });

  it("maps every intent to exactly one team, and uses every team once", () => {
    expect(Object.keys(INTENT_TO_TEAM).sort()).toEqual([...INTENTS].sort());
    expect(Object.values(INTENT_TO_TEAM).sort()).toEqual([...TEAMS].sort());
  });

  it("lists every intent exactly once in the precedence order", () => {
    expect([...INTENT_PRECEDENCE].sort()).toEqual([...INTENTS].sort());
  });

  it("picks the primary intent by precedence", () => {
    expect(primaryIntent(["technical_fault", "cancellation"])).toBe("cancellation");
    expect(primaryIntent(["billing_question", "complaint"])).toBe("complaint");
    expect(primaryIntent(["tariff_change", "billing_question"])).toBe("billing_question");
    expect(primaryIntent([])).toBe("other");
  });

  it("derives rule-based review reasons from the intent", () => {
    expect(ruleReviewReasons("cancellation")).toEqual(["cancellation"]);
    expect(ruleReviewReasons("complaint")).toEqual(["complaint"]);
    expect(ruleReviewReasons("billing_question")).toEqual([]);
  });
});
