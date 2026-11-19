// npm run eval:compare -- <run A> <run B> [--out file.md]
//
// Puts two evaluation runs side by side (P05): their settings, the headline metrics with the
// change from A to B, and per-language intent and urgency. Reads only run.json and
// metrics.json, so it is free and deterministic. Warns when the runs aren't comparable
// (different messages or dataset). P12 builds its prompt and model comparisons on this.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LANGUAGES } from "../src/taxonomy.js";
import type { Metrics } from "./metrics/aggregate.js";
import { resolveRunDir } from "./report/cli.js";
import { num, pct, usd, ms } from "./report/format.js";
import type { RunInfo } from "./run.js";

interface Run {
  info: RunInfo;
  metrics: Metrics;
}

function readRun(dir: string): Run {
  return {
    info: JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as RunInfo,
    metrics: JSON.parse(readFileSync(join(dir, "metrics.json"), "utf8")) as Metrics,
  };
}

const table = (header: string[], rows: string[][]) =>
  [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

const signed = (x: number, digits: number) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x).toFixed(digits)}`;

type Kind = "rate" | "score" | "usd" | "ms";
const format: Record<Kind, (x: number | null) => string> = {
  rate: (x) => pct(x),
  score: (x) => num(x),
  usd: (x) => usd(x),
  ms: (x) => ms(x),
};
/** Rates differ in percentage points; the rest in their own unit. */
function change(kind: Kind, a: number | null, b: number | null): string {
  if (a === null || b === null) return "–";
  const d = b - a;
  if (kind === "rate") return `${signed(d * 100, 1)} pp`;
  if (kind === "score") return signed(d, 2);
  if (kind === "usd") return `${signed(d, 4).replace(/^([+−±])/, "$1$")}`;
  return `${signed(d / 1000, 1)} s`;
}

export function compareRuns(a: Run, b: Run): string {
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines, "");
  const A = a.info;
  const B = b.info;

  push(`# Comparison: ${A.runId} → ${B.runId}`);

  const sameIds = A.ids.length === B.ids.length && A.ids.every((id, i) => B.ids[i] === id);
  if (!sameIds)
    push(
      `**Warning:** the runs cover different messages (${A.ids.length} vs ${B.ids.length}); differences mix messages and settings.`,
    );
  if (A.dataset.sha256 !== B.dataset.sha256)
    push("**Warning:** the runs used different dataset files; labels may differ.");
  if (!A.complete || !B.complete) push("**Warning:** at least one run is incomplete.");

  const masker = (r: RunInfo) => (r.masker ? r.masker.version : "none");
  push(
    table(
      ["Setting", "A", "B"],
      [
        ["Run", A.runId, B.runId],
        ["Set", `${A.set} (n=${a.metrics.n})`, `${B.set} (n=${b.metrics.n})`],
        [
          "Classifier",
          `${A.classifier.model}, effort ${A.classifier.effort}`,
          `${B.classifier.model}, effort ${B.classifier.effort}`,
        ],
        ["Prompt", A.classifier.promptVersion, B.classifier.promptVersion],
        ["Summary judge", `${A.judge.model}, ${A.judge.promptVersion}`, `${B.judge.model}, ${B.judge.promptVersion}`],
        ["Masking", masker(A), masker(B)],
        ["Dataset", A.dataset.sha256.slice(0, 12), B.dataset.sha256.slice(0, 12)],
      ],
    ),
  );

  const ma = a.metrics;
  const mb = b.metrics;
  const rows: [string, Kind, (m: Metrics) => number | null][] = [
    ["Valid outputs", "rate", (m) => m.overall.validRate],
    ["Intent accuracy", "rate", (m) => m.overall.intentAccuracy],
    ["Intent macro F1", "score", (m) => m.macroF1],
    ["Urgency accuracy", "rate", (m) => m.overall.urgencyAccuracy],
    ["Language accuracy", "rate", (m) => m.overall.languageAccuracy],
    ["Service type accuracy", "rate", (m) => m.overall.serviceTypeAccuracy],
    ["Area accuracy", "rate", (m) => m.overall.areaAccuracy],
    ["Identifiers precision", "rate", (m) => m.overall.identifiers.precision],
    ["Identifiers recall", "rate", (m) => m.overall.identifiers.recall],
    ["Identifier lists exact", "rate", (m) => m.overall.identifiers.exactListRate],
    ["Summary faithful (1–5)", "score", (m) => m.summaries.faithfulMean],
    ["Summary complete (1–5)", "score", (m) => m.summaries.completeMean],
    ["Summaries with personal data", "rate", (m) => m.summaries.personalDataShare],
    ["Mean confidence, right intents", "score", (m) => m.confidence.meanCorrect],
    ["Cost per message", "usd", (m) => m.cost.perMessageUsd],
    ["Latency p50", "ms", (m) => m.latencyMs.p50],
    ["Latency p95", "ms", (m) => m.latencyMs.p95],
  ];
  push("## Headline metrics");
  push(
    table(
      ["Metric", "A", "B", "Change"],
      rows.map(([label, kind, get]) => [
        label,
        format[kind](get(ma)),
        format[kind](get(mb)),
        change(kind, get(ma), get(mb)),
      ]),
    ),
  );
  push(
    `Summaries graded: ${ma.summaries.graded} vs ${mb.summaries.graded}. Invalid outputs: ${ma.outcomes.invalid} vs ${mb.outcomes.invalid}; errors: ${ma.outcomes.error} vs ${mb.outcomes.error}; fallbacks: ${ma.outcomes.fellBack} vs ${mb.outcomes.fellBack}.`,
  );

  // Routing (P12): what the model's output means for review. Runs scored before P07 have no
  // routing metrics; their cells show "–".
  const routing = (m: Metrics) => (m.overall as Partial<Metrics["overall"]>).routing;
  const routingRows: [string, Kind, (m: Metrics) => number | null][] = [
    ["Routing accuracy (team)", "rate", (m) => routing(m)?.accuracy ?? null],
    ["Must-review recall", "rate", (m) => routing(m)?.mustReview.recall ?? null],
    ["Must-review precision", "rate", (m) => routing(m)?.mustReview.precision ?? null],
    ["Review rate", "rate", (m) => routing(m)?.reviewRate ?? null],
  ];
  push("## Routing");
  push(
    table(
      ["Metric", "A", "B", "Change"],
      routingRows.map(([label, kind, get]) => [
        label,
        format[kind](get(ma)),
        format[kind](get(mb)),
        change(kind, get(ma), get(mb)),
      ]),
    ),
  );
  const missed = (m: Metrics) => {
    const r = routing(m);
    return r ? `${r.mustReview.fn} of ${r.mustReview.labelled}` : "–";
  };
  const router = (m: Metrics) => (m.routing as Metrics["routing"] | undefined)?.routerVersion ?? "–";
  push(`Must-review messages auto-routed: ${missed(ma)} vs ${missed(mb)}. Router: ${router(ma)} vs ${router(mb)}.`);

  push("## Per intent");
  push(
    table(
      ["Intent", "F1 A", "F1 B", "Change"],
      mb.perIntent.map((ib) => {
        const fa = ma.perIntent.find((ia) => ia.intent === ib.intent)?.f1 ?? null;
        return [`\`${ib.intent}\` (n=${ib.support})`, num(fa), num(ib.f1), change("score", fa, ib.f1)];
      }),
    ),
  );

  push("## By language");
  push(
    table(
      ["Language", "Intent A", "Intent B", "Change", "Urgency A", "Urgency B", "Change"],
      LANGUAGES.map((l) => {
        const la = ma.byLanguage[l];
        const lb = mb.byLanguage[l];
        return [
          `${l} (n=${lb.n}${lb.indicative ? ", indicative" : ""})`,
          pct(la.intentAccuracy),
          pct(lb.intentAccuracy),
          change("rate", la.intentAccuracy, lb.intentAccuracy),
          pct(la.urgencyAccuracy),
          pct(lb.urgencyAccuracy),
          change("rate", la.urgencyAccuracy, lb.urgencyAccuracy),
        ];
      }),
    ),
  );
  push("pp = percentage points. A change of one message is 1 pp on 100 messages and 5 pp on 20.");
  return out.join("\n").trimEnd() + "\n";
}

/** `<run A> <run B> [--out file.md]`, in any order. */
export function parseCompareArgs(args: readonly string[]): { refs: [string, string]; outFile: string | undefined } {
  const outIndex = args.indexOf("--out");
  const outFile = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const refs = outIndex >= 0 ? args.filter((_, i) => i !== outIndex && i !== outIndex + 1) : [...args];
  if (refs.length !== 2 || (outIndex >= 0 && !outFile)) {
    throw new Error("Usage: npm run eval:compare -- <run A> <run B> [--out file.md]");
  }
  return { refs: [refs[0]!, refs[1]!], outFile };
}

export function compareRunDirs(dirA: string, dirB: string): string {
  return compareRuns(readRun(dirA), readRun(dirB));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { refs, outFile } = parseCompareArgs(process.argv.slice(2));
    const markdown = compareRunDirs(resolveRunDir(refs[0]), resolveRunDir(refs[1]));
    if (outFile) {
      writeFileSync(outFile, markdown);
      console.log(`Wrote ${outFile}`);
    } else process.stdout.write(markdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
