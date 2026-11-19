// Aggregates scored messages into the run's metrics (P04 requirements.md, Metrics).
// Pure and deterministic: same input, same output, keys in a fixed order. Rates are rounded
// to 4 decimals and money to 6, so metrics.json is stable across machines.

import type { LlmUsage } from "../../src/llm/client.js";
import {
  INTENTS,
  LANGUAGES,
  REASON_CODES,
  REVIEW_REASONS,
  type Intent,
  type Language,
  type ReasonCode,
  type ReviewReason,
  type Team,
} from "../../src/taxonomy.js";
import type { MessageScore } from "./score.js";
import type { OutputLine } from "./types.js";

/** Languages with fewer messages than this are marked "indicative only" (tech-stack.md, Languages). */
export const INDICATIVE_BELOW = 30;
export const CONFIDENCE_BANDS = [
  { label: "< 0.5", min: 0, max: 0.5 },
  { label: "0.5–0.8", min: 0.5, max: 0.8 },
  { label: "0.8–0.9", min: 0.8, max: 0.9 },
  { label: "≥ 0.9", min: 0.9, max: Infinity },
] as const;

const round = (x: number, digits = 4) => Number(x.toFixed(digits));
/** null when the denominator is 0: "no data" is not the same as 0%. */
const rate = (num: number, den: number) => (den === 0 ? null : round(num / den));
const mean = (xs: readonly number[]) => (xs.length === 0 ? null : round(xs.reduce((a, b) => a + b, 0) / xs.length));

export interface Breakdown {
  n: number;
  indicative: boolean;
  validRate: number | null;
  intentAccuracy: number | null;
  urgencyAccuracy: number | null;
  languageAccuracy: number | null;
  serviceTypeAccuracy: number | null;
  areaAccuracy: number | null;
  identifiers: { precision: number | null; recall: number | null; exactListRate: number | null };
  routing: RoutingBreakdown;
}

/** Routing against the labels (P07): team accuracy and the must-review confusion counts. */
export interface RoutingBreakdown {
  /** Share of messages routed to the label's expected_team; invalid outputs go to general. */
  accuracy: number | null;
  mustReview: {
    labelled: number;
    reviewed: number;
    tp: number;
    fp: number;
    fn: number;
    recall: number | null;
    precision: number | null;
  };
  /** Share of all messages sent to review. */
  reviewRate: number | null;
}

export function routingBreakdown(scores: readonly MessageScore[]): RoutingBreakdown {
  const r = scores.map((s) => s.routing);
  const tp = r.filter((x) => x.labelMustReview && x.needsReview).length;
  const fp = r.filter((x) => !x.labelMustReview && x.needsReview).length;
  const fn = r.filter((x) => x.labelMustReview && !x.needsReview).length;
  return {
    accuracy: rate(r.filter((x) => x.team).length, r.length),
    mustReview: {
      labelled: tp + fn,
      reviewed: tp + fp,
      tp,
      fp,
      fn,
      recall: rate(tp, tp + fn),
      precision: rate(tp, tp + fp),
    },
    reviewRate: rate(tp + fp, r.length),
  };
}

/**
 * Which reason code is meant to catch each labelled review reason. `unclear` has no code of
 * its own: at runtime the model's low confidence stands in for it.
 */
export const REASON_CAUGHT_BY: Readonly<Record<ReviewReason, ReasonCode>> = {
  cancellation: "cancellation",
  complaint: "complaint",
  unclear: "low_confidence",
};

export function breakdown(scores: readonly MessageScore[]): Breakdown {
  const n = scores.length;
  const count = (f: (s: MessageScore) => boolean) => scores.filter(f).length;
  const tp = scores.reduce((a, s) => a + s.identifiers.tp, 0);
  const fp = scores.reduce((a, s) => a + s.identifiers.fp, 0);
  const fn = scores.reduce((a, s) => a + s.identifiers.fn, 0);
  return {
    n,
    indicative: n < INDICATIVE_BELOW,
    validRate: rate(
      count((s) => s.valid),
      n,
    ),
    intentAccuracy: rate(
      count((s) => s.intent),
      n,
    ),
    urgencyAccuracy: rate(
      count((s) => s.urgency),
      n,
    ),
    languageAccuracy: rate(
      count((s) => s.languageCorrect),
      n,
    ),
    serviceTypeAccuracy: rate(
      count((s) => s.serviceType),
      n,
    ),
    areaAccuracy: rate(
      count((s) => s.area),
      n,
    ),
    identifiers: {
      precision: rate(tp, tp + fp),
      recall: rate(tp, tp + fn),
      exactListRate: rate(
        count((s) => s.identifiers.exact),
        n,
      ),
    },
    routing: routingBreakdown(scores),
  };
}

export interface IntentMetrics {
  intent: Intent;
  /** Messages labelled with this intent. */
  support: number;
  /** Valid predictions of this intent. */
  predicted: number;
  correct: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export function perIntent(scores: readonly MessageScore[]): IntentMetrics[] {
  return INTENTS.map((intent) => {
    const support = scores.filter((s) => s.labelIntent === intent).length;
    const predicted = scores.filter((s) => s.predictedIntent === intent).length;
    const correct = scores.filter((s) => s.labelIntent === intent && s.predictedIntent === intent).length;
    const precision = rate(correct, predicted);
    const recall = rate(correct, support);
    // F1 is 0 when there was something to find or predict but nothing was right.
    const f1 =
      precision === null && recall === null
        ? null
        : (precision ?? 0) + (recall ?? 0) === 0
          ? 0
          : round((2 * (precision ?? 0) * (recall ?? 0)) / ((precision ?? 0) + (recall ?? 0)));
    return { intent, support, predicted, correct, precision, recall, f1 };
  });
}

export interface Confusion {
  /** Row labels: the labelled intents. */
  rows: Intent[];
  /** Column labels: the predicted intents, then "invalid" (invalid or failed attempts). */
  columns: (Intent | "invalid")[];
  counts: number[][];
}

export function confusion(scores: readonly MessageScore[]): Confusion {
  const columns: (Intent | "invalid")[] = [...INTENTS, "invalid"];
  return {
    rows: [...INTENTS],
    columns,
    counts: INTENTS.map((label) =>
      columns.map((col) => scores.filter((s) => s.labelIntent === label && s.predictedIntent === col).length),
    ),
  };
}

/** Nearest-rank percentile: the smallest value with at least q of the values at or below it. */
export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

const sumUsage = (usages: readonly LlmUsage[]): LlmUsage => ({
  input_tokens: usages.reduce((a, u) => a + u.input_tokens, 0),
  output_tokens: usages.reduce((a, u) => a + u.output_tokens, 0),
  cache_creation_input_tokens: usages.reduce((a, u) => a + u.cache_creation_input_tokens, 0),
  cache_read_input_tokens: usages.reduce((a, u) => a + u.cache_read_input_tokens, 0),
});

export interface Metrics {
  n: number;
  outcomes: { valid: number; invalid: number; error: number; fellBack: number };
  overall: Breakdown;
  byLanguage: Record<Language, Breakdown>;
  perIntent: IntentMetrics[];
  macroF1: number | null;
  confusion: Confusion;
  summaries: {
    graded: number;
    notGraded: number;
    faithfulMean: number | null;
    completeMean: number | null;
    personalDataShare: number | null;
    byLanguage: Record<Language, { graded: number; faithfulMean: number | null; completeMean: number | null }>;
  };
  confidence: {
    meanCorrect: number | null;
    meanWrong: number | null;
    bands: { band: string; n: number; intentAccuracy: number | null }[];
  };
  cost: {
    classifierUsd: number;
    judgeUsd: number;
    totalUsd: number;
    perMessageUsd: number | null;
    /** Calls whose serving model had no known price; their cost is missing from the totals. */
    unpricedCalls: number;
    classifierTokens: LlmUsage;
    judgeTokens: LlmUsage;
  };
  latencyMs: { p50: number | null; p95: number | null; max: number | null };
  worstErrors: {
    id: string;
    language: Language;
    label: Intent;
    predicted: Intent;
    confidence: number;
    summary: string;
  }[];
  routing: {
    enricherVersion: string;
    routerVersion: string;
    /** sha256 of the CRM seed the messages were enriched against. */
    seedSha256: string;
    /** How many messages each code fired on, in REASON_CODES order. */
    reasonCodes: { code: ReasonCode; n: number }[];
    /** For each labelled review reason: how many messages have it, and how many got its code. */
    labelledReasons: {
      reason: ReviewReason;
      caughtBy: ReasonCode;
      labelled: number;
      caught: number;
      rate: number | null;
    }[];
    /** Messages labelled must_review that were not sent to review. */
    missed: {
      id: string;
      language: Language;
      label: Intent;
      labelReasons: ReviewReason[];
      predictedTeam: Team;
      confidence: number | null;
    }[];
  };
}

/** What the routing scores were computed with, for the report's settings (P07). */
export interface RoutingInfo {
  enricherVersion: string;
  routerVersion: string;
  seedSha256: string;
}

export function computeMetrics(
  scores: readonly MessageScore[],
  lines: readonly OutputLine[],
  routingInfo: RoutingInfo,
): Metrics {
  const n = scores.length;
  const intents = perIntent(scores);
  const f1s = intents.map((i) => i.f1).filter((f): f is number => f !== null);
  const attempts = lines.map((l) => l.attempt);
  const judges = lines.map((l) => l.judge).filter((j) => j !== null);
  const graded = lines.filter((l) => l.judge?.outcome === "graded");
  const langOf = new Map(scores.map((s) => [s.id, s.language]));
  const validScores = scores.filter((s) => s.valid);

  const classifierUsd = attempts.reduce((a, t) => a + (t.costUsd ?? 0), 0);
  const judgeUsd = judges.reduce((a, j) => a + (j.costUsd ?? 0), 0);

  return {
    n,
    outcomes: {
      valid: attempts.filter((a) => a.outcome === "valid").length,
      invalid: attempts.filter((a) => a.outcome === "invalid").length,
      error: attempts.filter((a) => a.outcome === "error").length,
      fellBack: attempts.filter((a) => a.fellBack).length,
    },
    overall: breakdown(scores),
    byLanguage: Object.fromEntries(
      LANGUAGES.map((lang) => [lang, breakdown(scores.filter((s) => s.language === lang))]),
    ) as Record<Language, Breakdown>,
    perIntent: intents,
    macroF1: mean(f1s),
    confusion: confusion(scores),
    summaries: {
      graded: graded.length,
      notGraded: lines.filter((l) => l.attempt.outcome === "valid" && l.judge?.outcome !== "graded").length,
      faithfulMean: mean(graded.map((l) => l.judge!.scores!.faithful)),
      completeMean: mean(graded.map((l) => l.judge!.scores!.complete)),
      personalDataShare: rate(graded.filter((l) => l.judge!.scores!.contains_personal_data).length, graded.length),
      byLanguage: Object.fromEntries(
        LANGUAGES.map((lang) => {
          const g = graded.filter((l) => langOf.get(l.id) === lang);
          return [
            lang,
            {
              graded: g.length,
              faithfulMean: mean(g.map((l) => l.judge!.scores!.faithful)),
              completeMean: mean(g.map((l) => l.judge!.scores!.complete)),
            },
          ];
        }),
      ) as Metrics["summaries"]["byLanguage"],
    },
    confidence: {
      meanCorrect: mean(validScores.filter((s) => s.intent).map((s) => s.confidence!)),
      meanWrong: mean(validScores.filter((s) => !s.intent).map((s) => s.confidence!)),
      bands: CONFIDENCE_BANDS.map((b) => {
        const inBand = validScores.filter((s) => s.confidence! >= b.min && s.confidence! < b.max);
        return {
          band: b.label,
          n: inBand.length,
          intentAccuracy: rate(inBand.filter((s) => s.intent).length, inBand.length),
        };
      }),
    },
    cost: {
      classifierUsd: round(classifierUsd, 6),
      judgeUsd: round(judgeUsd, 6),
      totalUsd: round(classifierUsd + judgeUsd, 6),
      perMessageUsd: n === 0 ? null : round((classifierUsd + judgeUsd) / n, 6),
      unpricedCalls:
        attempts.filter((a) => a.costUsd === null).length + judges.filter((j) => j.costUsd === null).length,
      classifierTokens: sumUsage(attempts.map((a) => a.usage)),
      judgeTokens: sumUsage(judges.map((j) => j.usage)),
    },
    latencyMs: {
      p50: percentile(
        attempts.map((a) => a.latencyMs),
        0.5,
      ),
      p95: percentile(
        attempts.map((a) => a.latencyMs),
        0.95,
      ),
      max: attempts.length ? Math.max(...attempts.map((a) => a.latencyMs)) : null,
    },
    worstErrors: validScores
      .filter((s) => !s.intent)
      .sort((a, b) => b.confidence! - a.confidence! || a.id.localeCompare(b.id))
      .map((s) => ({
        id: s.id,
        language: s.language,
        label: s.labelIntent,
        predicted: s.predictedIntent as Intent,
        confidence: s.confidence!,
        summary: s.summary!,
      })),
    routing: {
      ...routingInfo,
      reasonCodes: REASON_CODES.map((code) => ({
        code,
        n: scores.filter((s) => s.routing.reasonCodes.includes(code)).length,
      })),
      labelledReasons: REVIEW_REASONS.map((reason) => {
        const caughtBy = REASON_CAUGHT_BY[reason];
        const withReason = scores.filter((s) => s.routing.labelReasons.includes(reason));
        const caught = withReason.filter((s) => s.routing.reasonCodes.includes(caughtBy)).length;
        return { reason, caughtBy, labelled: withReason.length, caught, rate: rate(caught, withReason.length) };
      }),
      missed: scores
        .filter((s) => s.routing.labelMustReview && !s.routing.needsReview)
        .map((s) => ({
          id: s.id,
          language: s.language,
          label: s.labelIntent,
          labelReasons: s.routing.labelReasons,
          predictedTeam: s.routing.predictedTeam,
          confidence: s.confidence,
        })),
    },
  };
}
