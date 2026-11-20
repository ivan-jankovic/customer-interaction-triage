// P14: the numbers in the README and docs/results.md equal the kept runs' metrics.json, so the
// docs can't go stale silently. Each check names the run it comes from and the exact text the doc
// shows; a new kept run that changes a number fails here until the docs are updated.

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
  overall: Rates & { validRate: number; n: number };
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

/** The README's headline table and limitations: [what, the run, the text README.md must contain] */
const IN_README: [string, string, string][] = [
  [
    "intent accuracy",
    RUNS.classify,
    `| Intent understood correctly | ${pct(o.intentAccuracy)} of ${c.overall.n} messages |`,
  ],
  [
    "must-review recall",
    RUNS.classify,
    `| Messages that needed a person, sent to a person | ${pct(mr.recall)} (${mr.tp} of ${mr.labelled}) |`,
  ],
  ["review rate", RUNS.classify, `| All messages sent to review | ${pct(o.routing.reviewRate)} |`],
  [
    "investigation cause accuracy",
    RUNS.investigate,
    `| Technical faults whose cause the agent found | ${pct(inv.accuracy)} (${Math.round(inv.accuracy * inv.n)} of ${inv.n}) |`,
  ],
  [
    "injection scenarios passed",
    RUNS.injection,
    `| Prompt-injection scenarios that failed to fool the system | ${inj.overall.passed} of ${inj.overall.scenarios}, in all ${inj.repeats / inj.n} repeats |`,
  ],
  [
    "cost and median latency per message",
    RUNS.classify,
    `| Cost and time per message | ${usd4(c.cost.perMessageUsd)}, ${sec(c.latencyMs.p50)} (median) |`,
  ],
  [
    "review rate, limitations",
    RUNS.classify,
    `${Math.round(o.routing.reviewRate * 100)}% of the dataset goes to review`,
  ],
];

/** The full results page: [what, the run it comes from, the text docs/results.md must contain] */
const IN_RESULTS: [string, string, string][] = [
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
    `**cause accuracy ${pct(inv.accuracy)}** (${Math.round(inv.accuracy * inv.n)} of ${inv.n}`,
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

/** A table row must be a whole line: "| Urgency accuracy | 89.0% |" is also the start of the Opus vs Sonnet row. */
function expectText(doc: string, text: string, why: string) {
  const content = readDoc(doc);
  if (text.startsWith("|")) expect(content.split("\n"), why).toContain(text);
  else expect(content, why).toContain(text);
}

describe.each([
  ["README.md", IN_README],
  ["docs/results.md", IN_RESULTS],
] as const)("numbers in %s match the kept reports", (doc, expected) => {
  it.each(expected)("%s (%s)", (_what, run, text) => {
    expectText(doc, text, `${doc} should contain: ${text}\n(from ${KEPT}/${run}/metrics.json)`);
  });
});

describe("the results page links every run it quotes", () => {
  it("links the kept reports", () => {
    const results = readDoc("docs/results.md");
    for (const run of [RUNS.classify, RUNS.investigate, RUNS.injection]) expect(results).toContain(`${KEPT}/${run}/`);
    expect(results).toContain(`${KEPT}/comparisons/p12-opus-vs-sonnet.md`);
  });
});
