// Metrics of an investigation evaluation (P10 requirements.md, "Evaluation"), computed only from
// the stored outputs, the dataset (languages) and the seed's designed causes, so the same inputs
// always give the same numbers. A labelled fault that wasn't investigated (the input run didn't
// classify it as a technical fault) counts as a miss, and an attempt without a valid answer
// counts as "no answer".

import type { InvestigationAttempt } from "../../src/pipeline/investigate.js";
import { isInconclusive } from "../../src/pipeline/route.js";
import {
  INVESTIGATE_TOOLS,
  INVESTIGATION_OUTCOMES,
  LANGUAGES,
  LIKELY_CAUSES,
  type InvestigationOutcome,
  type Language,
  type LikelyCause,
} from "../../src/taxonomy.js";

export interface InvestigationOutputLine {
  id: string;
  /** Why the message wasn't investigated; null when it was. */
  notInvestigated: string | null;
  attempt: InvestigationAttempt | null;
}

/** What the scoring needs per message besides the output: its language and designed cause. */
export interface CauseLabel {
  language: Language;
  expected: LikelyCause;
}

/** The predicted column of the confusion matrix: a cause, or why there is none. */
export const NO_ANSWER = "no answer";
export const NOT_INVESTIGATED = "not investigated";
export type Predicted = LikelyCause | typeof NO_ANSWER | typeof NOT_INVESTIGATED;
export const PREDICTED: readonly Predicted[] = [...LIKELY_CAUSES, NO_ANSWER, NOT_INVESTIGATED];

export interface MessageScore {
  id: string;
  language: Language;
  expected: LikelyCause;
  predicted: Predicted;
  correct: boolean;
  outcome: InvestigationOutcome | null;
  confidence: number | null;
  /** Would send the case to review (route.v3's investigation_inconclusive). */
  toReview: boolean;
  turns: number;
  tools: string[];
  toolErrors: number;
  costUsd: number | null;
  latencyMs: number;
}

export interface CauseStats {
  support: number;
  predicted: number;
  /** null when nothing was predicted (precision) or nothing is labelled (recall) as this cause. */
  precision: number | null;
  recall: number | null;
}

export interface InvestigationMetrics {
  n: number;
  investigated: number;
  notInvestigated: string[];
  accuracy: number;
  /** Over the labelled messages of each language; n = 0 languages are listed with null. */
  byLanguage: Record<Language, { n: number; accuracy: number | null }>;
  byCause: Record<LikelyCause, CauseStats>;
  /** confusion[expected][predicted] */
  confusion: Record<LikelyCause, Record<Predicted, number>>;
  outcomes: Record<InvestigationOutcome, number>;
  /** Share of investigated messages the investigation alone would send to review. */
  reviewRate: number | null;
  turns: { mean: number | null; max: number; stepLimitHits: number };
  toolCalls: { mean: number | null; max: number; byTool: Record<string, number>; errors: number };
  cost: { totalUsd: number; meanUsd: number | null; unknown: number };
  latency: { meanMs: number | null; maxMs: number };
  messages: MessageScore[];
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
const round = (x: number | null, digits = 6) => (x === null ? null : Math.round(x * 10 ** digits) / 10 ** digits);

export function scoreLine(line: InvestigationOutputLine, label: CauseLabel): MessageScore {
  const a = line.attempt;
  const predicted: Predicted =
    !a || line.notInvestigated !== null
      ? NOT_INVESTIGATED
      : a.outcome === "valid" && a.likelyCause
        ? a.likelyCause
        : NO_ANSWER;
  return {
    id: line.id,
    language: label.language,
    expected: label.expected,
    predicted,
    correct: predicted === label.expected,
    outcome: a?.outcome ?? null,
    confidence: a?.confidence ?? null,
    toReview: a ? isInconclusive(a) : false,
    turns: a?.steps ?? 0,
    tools: a?.toolCalls.map((c) => c.tool) ?? [],
    toolErrors: a?.toolCalls.filter((c) => c.is_error).length ?? 0,
    costUsd: a?.costUsd ?? 0,
    latencyMs: a?.latencyMs ?? 0,
  };
}

export function computeInvestigationMetrics(
  lines: readonly InvestigationOutputLine[],
  labels: ReadonlyMap<string, CauseLabel>,
): InvestigationMetrics {
  const messages = [...lines]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((line) => {
      const label = labels.get(line.id);
      if (!label) throw new Error(`${line.id} has no designed cause in the CRM seed.`);
      return scoreLine(line, label);
    });
  const investigated = messages.filter((m) => m.predicted !== NOT_INVESTIGATED);

  const confusion = Object.fromEntries(
    LIKELY_CAUSES.map((e) => [e, Object.fromEntries(PREDICTED.map((p) => [p, 0]))]),
  ) as InvestigationMetrics["confusion"];
  for (const m of messages) confusion[m.expected][m.predicted]++;

  const byCause = Object.fromEntries(
    LIKELY_CAUSES.map((cause) => {
      const support = messages.filter((m) => m.expected === cause).length;
      const predicted = messages.filter((m) => m.predicted === cause).length;
      const hits = messages.filter((m) => m.expected === cause && m.predicted === cause).length;
      return [
        cause,
        { support, predicted, precision: round(ratio(hits, predicted)), recall: round(ratio(hits, support)) },
      ];
    }),
  ) as Record<LikelyCause, CauseStats>;

  const byLanguage = Object.fromEntries(
    LANGUAGES.map((lang) => {
      const ofLang = messages.filter((m) => m.language === lang);
      return [
        lang,
        { n: ofLang.length, accuracy: round(ratio(ofLang.filter((m) => m.correct).length, ofLang.length)) },
      ];
    }),
  ) as InvestigationMetrics["byLanguage"];

  const outcomes = Object.fromEntries(INVESTIGATION_OUTCOMES.map((o) => [o, 0])) as Record<
    InvestigationOutcome,
    number
  >;
  for (const m of investigated) if (m.outcome) outcomes[m.outcome]++;

  const byTool: Record<string, number> = Object.fromEntries(INVESTIGATE_TOOLS.map((t) => [t, 0]));
  for (const m of investigated) for (const t of m.tools) byTool[t] = (byTool[t] ?? 0) + 1;

  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const known = investigated.filter((m) => m.costUsd !== null).map((m) => m.costUsd!);

  return {
    n: messages.length,
    investigated: investigated.length,
    notInvestigated: messages.filter((m) => m.predicted === NOT_INVESTIGATED).map((m) => m.id),
    accuracy: round(ratio(messages.filter((m) => m.correct).length, messages.length)) ?? 0,
    byLanguage,
    byCause,
    confusion,
    outcomes,
    reviewRate: round(ratio(investigated.filter((m) => m.toReview).length, investigated.length)),
    turns: {
      mean: round(ratio(sum(investigated.map((m) => m.turns)), investigated.length), 3),
      max: Math.max(0, ...investigated.map((m) => m.turns)),
      stepLimitHits: outcomes.step_limit,
    },
    toolCalls: {
      mean: round(ratio(sum(investigated.map((m) => m.tools.length)), investigated.length), 3),
      max: Math.max(0, ...investigated.map((m) => m.tools.length)),
      byTool,
      errors: sum(investigated.map((m) => m.toolErrors)),
    },
    cost: {
      totalUsd: round(sum(known)) ?? 0,
      meanUsd: round(ratio(sum(known), known.length)),
      unknown: investigated.length - known.length,
    },
    latency: {
      meanMs: round(ratio(sum(investigated.map((m) => m.latencyMs)), investigated.length), 0),
      maxMs: Math.max(0, ...investigated.map((m) => m.latencyMs)),
    },
    messages,
  };
}
