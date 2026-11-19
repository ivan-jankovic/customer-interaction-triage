import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defaultTeamFor,
  effectiveDecision,
  parseNote,
  parseReason,
  parseReviewer,
  REVIEWER_PATTERN,
  validateCorrection,
} from "../../src/review/rules.js";
import { INTENT_TO_TEAM, INTENTS } from "../../src/taxonomy.js";

describe("parseReviewer", () => {
  it.each(["reviewer-1", "ab", "a.b_c-9", "x".repeat(32)])("accepts %s", (h) => {
    expect(parseReviewer(` ${h} `)).toEqual({ ok: true, value: h });
  });

  it.each(["", "a", "Reviewer", "-abc", "jan novák", "x".repeat(33), "a/b"])("rejects %j", (h) => {
    expect(parseReviewer(h).ok).toBe(false);
  });

  it("explains how to give one when missing", () => {
    expect(parseReviewer(undefined)).toMatchObject({ ok: false, error: expect.stringContaining("REVIEWER") as string });
  });

  it("uses the same pattern as the migration's check", () => {
    const migration = readFileSync("src/db/migrations/0008_reviews.ts", "utf8");
    expect(migration).toContain(`'${REVIEWER_PATTERN.source}'`);
  });
});

describe("notes and reasons", () => {
  it("trims a note and turns an empty one into null", () => {
    expect(parseNote("  ok ")).toEqual({ ok: true, value: "ok" });
    expect(parseNote("   ")).toEqual({ ok: true, value: null });
    expect(parseNote("x".repeat(1001)).ok).toBe(false);
  });

  it("requires a reason of 3-500 characters", () => {
    expect(parseReason(" to call back ")).toEqual({ ok: true, value: "to call back" });
    expect(parseReason("ab").ok).toBe(false);
    expect(parseReason(undefined).ok).toBe(false);
    expect(parseReason("x".repeat(501)).ok).toBe(false);
  });
});

describe("validateCorrection", () => {
  const base = { caseIntent: "billing_question", caseTeam: "billing", note: "wrong intent" } as const;

  it("defaults the team to the intent's team", () => {
    for (const intent of INTENTS) expect(defaultTeamFor(intent)).toBe(INTENT_TO_TEAM[intent]);
  });

  it("accepts a new intent, a team override, or both", () => {
    expect(validateCorrection({ ...base, intent: "cancellation", team: "retention" })).toEqual({
      ok: true,
      value: { intent: "cancellation", team: "retention", note: "wrong intent" },
    });
    expect(validateCorrection({ ...base, intent: "billing_question", team: "retention" }).ok).toBe(true);
  });

  it("needs a note", () => {
    expect(validateCorrection({ ...base, intent: "complaint", team: "complaints", note: "  " })).toMatchObject({
      ok: false,
      error: expect.stringContaining("note") as string,
    });
  });

  it("refuses a correction that changes nothing", () => {
    expect(validateCorrection({ ...base, intent: "billing_question", team: "billing" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("confirm") as string,
    });
  });

  it("treats any intent as a change for a case without a classification", () => {
    expect(
      validateCorrection({ caseIntent: null, caseTeam: "general", intent: "other", team: "general", note: "n" }).ok,
    ).toBe(true);
  });
});

describe("effectiveDecision", () => {
  const pending = { targetTeam: "billing", needsReview: true } as const;
  const auto = { targetTeam: "sales", needsReview: false } as const;

  it("is pending or auto-routed without a review", () => {
    expect(effectiveDecision(pending, "billing_question", null)).toEqual({
      status: "pending",
      intent: "billing_question",
      team: "billing",
    });
    expect(effectiveDecision(auto, "tariff_change", null)).toEqual({
      status: "auto-routed",
      intent: "tariff_change",
      team: "sales",
    });
  });

  it("keeps the case's team and intent when confirmed", () => {
    expect(
      effectiveDecision(pending, "billing_question", {
        decision: "confirmed",
        correctedIntent: null,
        correctedTeam: null,
      }),
    ).toEqual({ status: "confirmed", intent: "billing_question", team: "billing" });
  });

  it("takes the review's values when corrected, also for a failure case without a classification", () => {
    const review = { decision: "corrected", correctedIntent: "cancellation", correctedTeam: "retention" } as const;
    expect(effectiveDecision(pending, "billing_question", review)).toEqual({
      status: "corrected",
      intent: "cancellation",
      team: "retention",
    });
    expect(effectiveDecision({ targetTeam: "general", needsReview: true }, null, review).intent).toBe("cancellation");
  });
});
