// Metrics on the 8-message fixture (test/eval/fixtures/eval-fixture.ts). Each expected value
// is worked out by hand in the comments; the code must agree with the arithmetic.

import { describe, expect, it } from "vitest";
import { makeMessageRouter } from "../../eval/lib/route-message.js";
import { computeMetrics, percentile } from "../../eval/metrics/aggregate.js";
import { compareIdentifiers, scoreMessage } from "../../eval/metrics/score.js";
import { FIXTURE, FIXTURE_SEED } from "./fixtures/eval-fixture.js";

const router = makeMessageRouter(FIXTURE_SEED);
const routes = await Promise.all(FIXTURE.map((m) => router(m, m.line.attempt)));
const scores = FIXTURE.map((m, i) => scoreMessage(m.id, m.language, m.labels, m.line.attempt, routes[i]!));
const ROUTING_INFO = { enricherVersion: "enrich.v1", routerVersion: "route.v1", seedSha256: "e".repeat(64) };
const metrics = computeMetrics(
  scores,
  FIXTURE.map((m) => m.line),
  ROUTING_INFO,
);

describe("identifier comparison", () => {
  it("compares values exactly as written, as a multiset", () => {
    const a = { type: "phone", value: "+420 001 111 111" };
    expect(compareIdentifiers([a], [a])).toEqual({ tp: 1, fp: 0, fn: 0, exact: true });
    expect(compareIdentifiers([a], [{ type: "phone", value: "+420001111111" }])).toEqual({
      tp: 0,
      fp: 1,
      fn: 1,
      exact: false,
    });
    expect(compareIdentifiers([a], [a, a])).toEqual({ tp: 1, fp: 1, fn: 0, exact: false });
    expect(compareIdentifiers([], [])).toEqual({ tp: 0, fp: 0, fn: 0, exact: true });
  });
});

describe("computeMetrics on the fixture", () => {
  it("counts outcomes: 6 valid, 1 invalid (m4), 1 error (m6), 1 fallback (m3)", () => {
    expect(metrics.n).toBe(8);
    expect(metrics.outcomes).toEqual({ valid: 6, invalid: 1, error: 1, fellBack: 1 });
  });

  it("computes overall accuracies, counting invalid and error as wrong", () => {
    expect(metrics.overall).toEqual({
      n: 8,
      indicative: true,
      validRate: 0.75, // 6/8
      intentAccuracy: 0.5, // m1 m3 m5 m8
      urgencyAccuracy: 0.5, // m1 m2 m5 m7
      languageAccuracy: 0.625, // all valid but m5
      serviceTypeAccuracy: 0.625, // all valid but m8
      areaAccuracy: 0.625, // all valid but m7; m1 "kolin" = "Kolín"
      identifiers: {
        precision: 0.5, // tp 2 (m1, m8) / predicted 4 (m1, m2, m3, m8)
        recall: 0.4, // tp 2 / expected 5 (m1, m2, m4, m8 ×2)
        exactListRate: 0.375, // m1, m5, m7
      },
      routing: metrics.overall.routing, // checked in "routing on the fixture" below
    });
  });

  it("breaks the accuracies down by language and marks small groups indicative", () => {
    expect(metrics.byLanguage.cs).toMatchObject({ n: 4, indicative: true, intentAccuracy: 0.5, validRate: 1 });
    expect(metrics.byLanguage.sk).toMatchObject({ n: 2, intentAccuracy: 0.5, validRate: 0.5, urgencyAccuracy: 0 });
    expect(metrics.byLanguage.en).toMatchObject({ n: 2, intentAccuracy: 0.5, validRate: 0.5, languageAccuracy: 0 });
  });

  it("computes per-intent precision, recall and F1, and macro F1", () => {
    const byIntent = Object.fromEntries(metrics.perIntent.map((i) => [i.intent, i]));
    expect(byIntent.billing_question).toEqual({
      intent: "billing_question",
      support: 1,
      predicted: 2,
      correct: 1,
      precision: 0.5,
      recall: 1,
      f1: 0.6667,
    });
    expect(byIntent.technical_fault).toMatchObject({ support: 2, predicted: 1, precision: 1, recall: 0.5, f1: 0.6667 });
    expect(byIntent.tariff_change).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    // Never predicted: precision has no denominator (null), recall is 0, F1 is 0.
    expect(byIntent.cancellation).toMatchObject({ support: 1, predicted: 0, precision: null, recall: 0, f1: 0 });
    expect(byIntent.complaint).toMatchObject({ support: 2, predicted: 2, precision: 0.5, recall: 0.5, f1: 0.5 });
    expect(byIntent.other).toMatchObject({ precision: null, recall: 0, f1: 0 });
    // (0.6667 + 0.6667 + 1 + 0 + 0.5 + 0) / 6
    expect(metrics.macroF1).toBe(0.4722);
  });

  it("builds the confusion matrix with an invalid column", () => {
    expect(metrics.confusion.columns).toEqual([
      "billing_question",
      "technical_fault",
      "tariff_change",
      "cancellation",
      "complaint",
      "other",
      "invalid",
    ]);
    expect(metrics.confusion.counts).toEqual([
      [1, 0, 0, 0, 0, 0, 0], // billing_question: m3
      [0, 1, 0, 0, 1, 0, 0], // technical_fault: m1 right, m7 → complaint
      [0, 0, 1, 0, 0, 0, 0], // tariff_change: m5
      [0, 0, 0, 0, 0, 0, 1], // cancellation: m4 invalid
      [1, 0, 0, 0, 1, 0, 0], // complaint: m2 → billing, m8 right
      [0, 0, 0, 0, 0, 0, 1], // other: m6 error
    ]);
  });

  it("summarises the judge's grades", () => {
    expect(metrics.summaries).toEqual({
      graded: 5, // m1 m2 m3 m5 m8
      notGraded: 1, // m7: judge output invalid
      faithfulMean: 4.2, // (5 + 4 + 5 + 3 + 4) / 5
      completeMean: 4, // (4 + 3 + 5 + 4 + 4) / 5
      personalDataShare: 0.2, // m3
      byLanguage: {
        cs: { graded: 3, faithfulMean: 4.3333, completeMean: 3.6667 }, // m1 m2 m8
        sk: { graded: 1, faithfulMean: 5, completeMean: 5 },
        en: { graded: 1, faithfulMean: 3, completeMean: 4 },
      },
    });
  });

  it("splits confidence by correctness and into bands", () => {
    expect(metrics.confidence).toEqual({
      meanCorrect: 0.7325, // (0.95 + 0.70 + 0.40 + 0.88) / 4
      meanWrong: 0.885, // (0.85 + 0.92) / 2
      bands: [
        { band: "< 0.5", n: 1, intentAccuracy: 1 }, // m5
        { band: "0.5–0.8", n: 1, intentAccuracy: 1 }, // m3
        { band: "0.8–0.9", n: 2, intentAccuracy: 0.5 }, // m2 wrong, m8 right
        { band: "≥ 0.9", n: 2, intentAccuracy: 0.5 }, // m1 right, m7 wrong
      ],
    });
  });

  it("adds up cost and tokens, counting unpriced calls", () => {
    expect(metrics.cost).toEqual({
      classifierUsd: 0.045, // 0.008 + 0.007 + 0.006 + 0.007 + 0 + 0.009 + 0.008 (m3 unknown)
      judgeUsd: 0.0012, // 6 judge calls × 0.0002 (m7's invalid grade still cost)
      totalUsd: 0.0462,
      perMessageUsd: 0.005775,
      unpricedCalls: 1,
      classifierTokens: {
        input_tokens: 700,
        output_tokens: 350,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 7000,
      },
      judgeTokens: {
        input_tokens: 1800,
        output_tokens: 240,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
  });

  it("reports nearest-rank latency percentiles", () => {
    // sorted: 100 1500 2000 2200 2500 3000 3500 4000
    expect(metrics.latencyMs).toEqual({ p50: 2200, p95: 4000, max: 4000 });
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
  });

  it("lists wrong intents by confidence, highest first", () => {
    expect(metrics.worstErrors.map((e) => [e.id, e.label, e.predicted, e.confidence])).toEqual([
      ["m7", "technical_fault", "complaint", 0.92],
      ["m2", "complaint", "billing_question", 0.85],
    ]);
  });
});

describe("routing on the fixture (table at the top of eval-fixture.ts)", () => {
  it("routes each message as worked out by hand", () => {
    expect(
      Object.fromEntries(scores.map((s) => [s.id, [s.routing.predictedTeam, s.routing.reasonCodes.join("+")]])),
    ).toEqual({
      m1: ["technical_support", ""],
      m2: ["billing", "customer_not_found"],
      m3: ["billing", ""],
      m4: ["general", "invalid_output"],
      m5: ["sales", "low_confidence"],
      m6: ["general", "classification_error"],
      m7: ["complaints", "complaint"],
      m8: ["complaints", "complaint+crm_mismatch_service_type"],
    });
  });

  it("computes routing accuracy and the must-review counts", () => {
    // Team right: m1, m3, m5, m6, m8 = 5/8. Labelled must-review: m2, m3, m4, m5, m8 (5).
    // Reviewed: m2, m4, m5, m6, m7, m8 (6). TP 4 (m2, m4, m5, m8), FP 2 (m6, m7), FN 1 (m3).
    expect(metrics.overall.routing).toEqual({
      accuracy: 0.625,
      mustReview: { labelled: 5, reviewed: 6, tp: 4, fp: 2, fn: 1, recall: 0.8, precision: 0.6667 },
      reviewRate: 0.75,
    });
    // sk: m3 (missed), m4 (caught).
    expect(metrics.byLanguage.sk.routing.mustReview).toMatchObject({ tp: 1, fn: 1, recall: 0.5 });
  });

  it("counts reason codes, labelled reasons and the missed messages", () => {
    const n = Object.fromEntries(metrics.routing.reasonCodes.map((r) => [r.code, r.n]));
    expect(n).toMatchObject({ complaint: 2, customer_not_found: 1, low_confidence: 1, crm_mismatch_service_type: 1 });
    expect(n.investigation_inconclusive).toBe(0);
    expect(metrics.routing.labelledReasons).toEqual([
      // m4 is labelled cancellation but its output was invalid, so it got invalid_output instead.
      { reason: "cancellation", caughtBy: "cancellation", labelled: 1, caught: 0, rate: 0 },
      // m2 (predicted billing_question) and m8; only m8 got `complaint`.
      { reason: "complaint", caughtBy: "complaint", labelled: 2, caught: 1, rate: 0.5 },
      { reason: "unclear", caughtBy: "low_confidence", labelled: 2, caught: 1, rate: 0.5 },
    ]);
    expect(metrics.routing.missed).toEqual([
      {
        id: "m3",
        language: "sk",
        label: "billing_question",
        labelReasons: ["unclear"],
        predictedTeam: "billing",
        confidence: 0.7,
      },
    ]);
    expect(metrics.routing).toMatchObject(ROUTING_INFO);
  });
});
