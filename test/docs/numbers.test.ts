// P14: the README's headline numbers equal the kept runs' metrics.json, so the README can't go
// stale silently. Each check names the run it comes from and the exact text the README shows;
// a new kept run that changes a number fails here until the README is updated.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, readDoc } from "./markdown.js";

const KEPT = "eval/results/kept";
export const RUNS = {
  classify: "20261119-010458-full-claude-opus-5-5-classify.v2",
  sonnet: "20261119-232004-full-claude-sonnet-5-5-classify.v2",
  investigate: "20261119-162816-investigate-full-claude-opus-5-5-investigate.v1",
  injection: "20261119-182812-injection-x5-claude-opus-5-5-classify.v2",
} as const;

// The metrics files are JSON written by the eval scripts; only the fields used here are typed.
interface Rates {
  intentAccuracy: number;
  urgencyAccuracy: number;
  serviceTypeAccuracy: number;
  areaAccuracy: number;
  routing: {
    accuracy: number;
    reviewRate: number;
    mustReview: { labelled: number; tp: number; recall: number; precision: number };
  };
}
interface ClassifyMetrics {
  overall: Rates & { validRate: number };
  byLanguage: Record<"cs" | "sk" | "en", Rates>;
  macroF1: number;
  cost: { perMessageUsd: number };
  latencyMs: { p50: number; p95: number };
}
interface InvestigateMetrics {
  n: number;
  accuracy: number;
  reviewRate: number;
  cost: { meanUsd: number };
  latency: { meanMs: number };
}
interface InjectionMetrics {
  n: number;
  repeats: number;
  overall: { scenarios: number; passed: number };
  cost: { totalUsd: number };
}

const metrics = <T>(run: string): T => JSON.parse(readFileSync(join(ROOT, KEPT, run, "metrics.json"), "utf8")) as T;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd4 = (x: number) => `$${x.toFixed(4)}`;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const c = metrics<ClassifyMetrics>(RUNS.classify);
const s = metrics<ClassifyMetrics>(RUNS.sonnet);
const inv = metrics<InvestigateMetrics>(RUNS.investigate);
const inj = metrics<InjectionMetrics>(RUNS.injection);
const o = c.overall;
const mr = o.routing.mustReview;

/** [what, the run it comes from, the text the README must contain] */
const EXPECTED: [string, string, string][] = [
  ["valid outputs", RUNS.classify, `| Valid outputs | ${pct(o.validRate)} |`],
  [
    "intent accuracy",
    RUNS.classify,
    `| Intent accuracy | ${pct(o.intentAccuracy)} (macro F1 ${c.macroF1.toFixed(3)}) |`,
  ],
  ["urgency accuracy", RUNS.classify, `| Urgency accuracy | ${pct(o.urgencyAccuracy)} |`],
  [
    "service type and area accuracy",
    RUNS.classify,
    `| Service type / area accuracy | ${pct(o.serviceTypeAccuracy)} / ${pct(o.areaAccuracy)} |`,
  ],
  ["routing accuracy", RUNS.classify, `| Routing accuracy (team) | ${pct(o.routing.accuracy)} |`],
  [
    "must-review recall and precision",
    RUNS.classify,
    `| Must-review recall / precision | ${pct(mr.recall)} (${mr.tp} of ${mr.labelled}) / ${pct(mr.precision)} |`,
  ],
  ["review rate", RUNS.classify, `| Sent to review | ${pct(o.routing.reviewRate)} |`],
  ["review rate, explained", RUNS.classify, `**Why ${Math.round(o.routing.reviewRate * 100)}% go to review:**`],
  [
    "review rate, limitations",
    RUNS.classify,
    `${Math.round(o.routing.reviewRate * 100)}% of the dataset goes to review`,
  ],
  ["cost per message", RUNS.classify, `| Cost per message | ${usd4(c.cost.perMessageUsd)} |`],
  ["latency", RUNS.classify, `| Latency p50 / p95 | ${sec(c.latencyMs.p50)} / ${sec(c.latencyMs.p95)} |`],
  [
    "urgency by language",
    RUNS.classify,
    `| Urgency | ${pct(c.byLanguage.cs.urgencyAccuracy)} | ${pct(c.byLanguage.sk.urgencyAccuracy)} | ${pct(c.byLanguage.en.urgencyAccuracy)} |`,
  ],
  [
    "investigation cause accuracy",
    RUNS.investigate,
    `**cause accuracy ${pct(inv.accuracy)}** (${Math.round(inv.accuracy * inv.n)} of ${inv.n})`,
  ],
  ["investigation review rate", RUNS.investigate, `${pct(inv.reviewRate)} sent to review by the investigation`],
  [
    "investigation cost and latency per fault",
    RUNS.investigate,
    `${usd4(inv.cost.meanUsd)} and ${sec(inv.latency.meanMs)} per fault`,
  ],
  [
    "injection scenarios passed",
    RUNS.injection,
    `**${inj.overall.passed} of ${inj.overall.scenarios} scenarios passed in all ${inj.repeats / inj.n} repeats**`,
  ],
  ["injection cost", RUNS.injection, `Cost $${inj.cost.totalUsd.toFixed(2)}.`],
  [
    "Opus vs Sonnet urgency",
    RUNS.sonnet,
    `| Urgency accuracy | ${pct(o.urgencyAccuracy)} | ${pct(s.overall.urgencyAccuracy)} |`,
  ],
  [
    "Opus vs Sonnet cost",
    RUNS.sonnet,
    `| Cost per message | ${usd4(c.cost.perMessageUsd)} | ${usd4(s.cost.perMessageUsd)} |`,
  ],
  [
    "Opus vs Sonnet latency",
    RUNS.sonnet,
    `| Latency p50 / p95 | ${sec(c.latencyMs.p50)} / ${sec(c.latencyMs.p95)} | ${sec(s.latencyMs.p50)} / ${sec(s.latencyMs.p95)} |`,
  ],
  [
    "Sonnet's share of the cost",
    RUNS.sonnet,
    `at ${Math.round((s.cost.perMessageUsd / c.cost.perMessageUsd) * 100)}% of the cost`,
  ],
];

describe("README numbers match the kept reports", () => {
  const readme = readDoc("README.md");
  const lines = readme.split("\n");

  it.each(EXPECTED)("%s (%s)", (_what, run, text) => {
    const why = `README should contain: ${text}\n(from ${KEPT}/${run}/metrics.json)`;
    // A table row must be a whole line: "| Urgency accuracy | 89.0% |" is also the start of the
    // Opus vs Sonnet row, so a substring match could pass on the wrong table.
    if (text.startsWith("|")) expect(lines, why).toContain(text);
    else expect(readme, why).toContain(text);
  });

  it("links every run it quotes", () => {
    for (const run of [RUNS.classify, RUNS.investigate, RUNS.injection]) expect(readme).toContain(`${KEPT}/${run}/`);
    expect(readme).toContain(`${KEPT}/comparisons/p12-opus-vs-sonnet.md`);
  });
});
