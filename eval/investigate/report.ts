// metrics.json, report.md and report.html of an investigation evaluation (P10). Both reports
// are rendered from one list of sections, so they hold the same content; everything depends
// only on run.json, outputs.jsonl, the dataset and the CRM seed, so `npm run eval:report`
// recomputes them byte for byte.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CRM_SEED_PATH, readCrmSeed } from "../../src/db/crm-seed.js";
import { LANGUAGES, LIKELY_CAUSES } from "../../src/taxonomy.js";
import { sha256File } from "../lib/hash.js";
import { readJsonl } from "../lib/jsonl.js";
import { int, ms, num, pct, usd } from "../report/format.js";
import { CSS, esc } from "../report/html.js";
import type { RunReport } from "../lib/run-guard.js";
import type { DatasetRecord } from "../schema/dataset-record.schema.js";
import {
  computeInvestigationMetrics,
  PREDICTED,
  type CauseLabel,
  type InvestigationMetrics,
  type InvestigationOutputLine,
} from "./metrics.js";

export interface InvestigationRunInfo {
  kind: "investigate";
  runId: string;
  set: "full" | "small";
  /** The labelled technical faults of the set. */
  ids: string[];
  startedAt: string;
  finishedAt: string | null;
  complete: boolean;
  investigator: {
    model: string;
    effort: string;
    promptVersion: string;
    promptSha256: string;
    investigatorVersion: string;
    maxTurns: number;
  };
  /** The classify run whose stored classifications fed the agent. */
  input: { runId: string; dir: string; classifierPromptVersion: string };
  masker: { version: string };
  enricherVersion: string;
  seed: { file: string; sha256: string };
  dataset: { file: string; sha256: string };
  git: { commit: string; dirty: boolean };
  options: { maxCost: number; concurrency: number };
  guard: Omit<RunReport, "script" | "dryRun" | "started" | "finished"> | null;
}

export function isInvestigationRun(run: unknown): run is InvestigationRunInfo {
  return typeof run === "object" && run !== null && (run as { kind?: unknown }).kind === "investigate";
}

/** The designed cause and language of every labelled technical fault. */
export function causeLabels(seedPath: string, datasetPath: string): Map<string, CauseLabel> {
  const languages = new Map(readJsonl<DatasetRecord>(datasetPath).map((r) => [r.id, r.language]));
  const labels = new Map<string, CauseLabel>();
  for (const m of readCrmSeed(seedPath).messages) {
    if (m.expected_cause === null) continue;
    labels.set(m.message_id, { expected: m.expected_cause, language: languages.get(m.message_id)! });
  }
  return labels;
}

type Cell = string | number;
interface Section {
  heading?: string;
  paragraphs?: string[];
  table?: { header: string[]; rows: Cell[][]; numeric?: number[] };
}

/** Markdown-ish inline code (`x`) is the only markup paragraphs use. */
const inlineHtml = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

function sections(run: InvestigationRunInfo, m: InvestigationMetrics): Section[] {
  const out: Section[] = [];
  const inv = run.investigator;
  out.push({
    table: {
      header: ["Setting", "Value"],
      rows: [
        ["Set", `${run.set} (${run.ids.length} labelled technical faults)`],
        [
          "Agent",
          `${inv.model}, effort ${inv.effort}, prompt ${inv.promptVersion}, ${inv.investigatorVersion}, at most ${inv.maxTurns} turns`,
        ],
        ["Input", `classify run ${run.input.runId} (${run.input.classifierPromptVersion})`],
        [
          "Masking and enrichment",
          `${run.masker.version}, ${run.enricherVersion}, CRM seed sha256 ${run.seed.sha256.slice(0, 12)}`,
        ],
        ["Dataset", `${run.dataset.file} (sha256 ${run.dataset.sha256.slice(0, 12)})`],
        ["Code", `${run.git.commit.slice(0, 12)}${run.git.dirty ? " (with uncommitted changes)" : ""}`],
        ["Started", run.startedAt],
        ["Complete", run.complete ? "yes" : `no: ${m.investigated} of ${run.ids.length} faults investigated`],
      ],
    },
  });
  out.push({
    paragraphs: [
      `The labels are the causes designed into the mock CRM (\`expected_cause\` in the seed). The scoring is deterministic: \`npm run eval:report -- ${run.runId}\` recomputes this report from the stored outputs.`,
      `With ${m.n} faults, and one or two examples of some causes, the per-cause and per-language numbers are indicative only.`,
    ],
  });

  out.push({
    heading: "Overall",
    table: {
      header: ["Metric", "Value"],
      rows: [
        ["Faults", m.n],
        [
          "Investigated",
          `${m.investigated}${m.notInvestigated.length ? ` (not: ${m.notInvestigated.join(", ")})` : ""}`,
        ],
        ["Cause accuracy", pct(m.accuracy)],
        ["Sent to review by the investigation", pct(m.reviewRate)],
        [
          "Outcomes",
          Object.entries(m.outcomes)
            .map(([o, n]) => `${o} ${n}`)
            .join(", "),
        ],
        [
          "Turns per investigation",
          `mean ${num(m.turns.mean)}, max ${m.turns.max}, step-limit hits ${m.turns.stepLimitHits}`,
        ],
        [
          "Tool calls per investigation",
          `mean ${num(m.toolCalls.mean)}, max ${m.toolCalls.max}, errors ${m.toolCalls.errors}`,
        ],
        [
          "Tool calls by tool",
          Object.entries(m.toolCalls.byTool)
            .map(([t, n]) => `${t} ${n}`)
            .join(", "),
        ],
        [
          "Cost",
          `${usd(m.cost.totalUsd)} total, ${usd(m.cost.meanUsd)} per fault${m.cost.unknown ? ` (${m.cost.unknown} unknown)` : ""}`,
        ],
        ["Latency", `mean ${ms(m.latency.meanMs)}, max ${ms(m.latency.maxMs)}`],
      ],
    },
  });

  out.push({
    heading: "Per cause",
    table: {
      header: ["Cause", "Labelled", "Predicted", "Precision", "Recall"],
      rows: LIKELY_CAUSES.map((c) => {
        const s = m.byCause[c];
        return [c, s.support, s.predicted, pct(s.precision), pct(s.recall)];
      }),
      numeric: [1, 2, 3, 4],
    },
  });

  out.push({
    heading: "Confusion matrix",
    paragraphs: ["Rows: designed cause. Columns: the agent's answer."],
    table: {
      header: ["designed \\ answer", ...PREDICTED],
      rows: LIKELY_CAUSES.map((c) => [c, ...PREDICTED.map((p) => int(m.confusion[c][p]))]),
      numeric: PREDICTED.map((_, i) => i + 1),
    },
  });

  out.push({
    heading: "Per language",
    table: {
      header: ["Language", "Faults", "Cause accuracy"],
      rows: LANGUAGES.map((l) => [l, m.byLanguage[l].n, pct(m.byLanguage[l].accuracy)]),
      numeric: [1, 2],
    },
  });

  out.push({
    heading: "Per message",
    table: {
      header: ["Message", "Lang", "Designed", "Answer", "Confidence", "Outcome", "Review", "Turns", "Tools", "Cost"],
      rows: m.messages.map((x) => [
        x.id,
        x.language,
        x.expected,
        `${x.predicted}${x.correct ? "" : " ✗"}`,
        num(x.confidence),
        x.outcome ?? "–",
        x.toReview ? "yes" : "no",
        x.turns,
        x.tools.join(", ") || "–",
        usd(x.costUsd),
      ]),
      numeric: [4, 7, 9],
    },
  });
  return out;
}

export function renderInvestigationMarkdown(run: InvestigationRunInfo, m: InvestigationMetrics): string {
  const lines: string[] = [`# Investigation evaluation ${run.runId}`, ""];
  for (const s of sections(run, m)) {
    if (s.heading) lines.push(`## ${s.heading}`, "");
    for (const p of s.paragraphs ?? []) lines.push(p, "");
    if (s.table) {
      const { header, rows } = s.table;
      lines.push(`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`);
      for (const r of rows) lines.push(`| ${r.join(" | ")} |`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function renderInvestigationHtml(run: InvestigationRunInfo, m: InvestigationMetrics): string {
  const body: string[] = [`<h1>Investigation evaluation</h1>`, `<p class="muted">${esc(run.runId)}</p>`];
  for (const s of sections(run, m)) {
    if (s.heading) body.push(`<h2>${esc(s.heading)}</h2>`);
    for (const p of s.paragraphs ?? []) body.push(`<p>${inlineHtml(p)}</p>`);
    if (s.table) {
      const numeric = new Set(s.table.numeric ?? []);
      const cls = (i: number) => (numeric.has(i) ? ' class="n"' : "");
      const head = s.table.header.map((h, i) => `<th${cls(i)}>${esc(h)}</th>`).join("");
      const rows = s.table.rows
        .map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${esc(String(c))}</td>`).join("")}</tr>`)
        .join("\n");
      body.push(`<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table></div>`);
    }
  }
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Investigation evaluation</title>`,
    `<style>${CSS}</style>`,
    "</head>",
    "<body><main>",
    ...body,
    "</main></body>",
    "</html>",
    "",
  ].join("\n");
}

export interface WriteInvestigationReportsOptions {
  datasetPath: string;
  crmSeedPath?: string;
  log?: (line: string) => void;
}

export function writeInvestigationReports(
  runDir: string,
  options: WriteInvestigationReportsOptions,
): InvestigationMetrics {
  const log = options.log ?? console.log;
  const seedPath = options.crmSeedPath ?? CRM_SEED_PATH;
  const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as InvestigationRunInfo;
  const seedHash = sha256File(seedPath);
  if (seedHash !== run.seed.sha256) {
    log(
      `Warning: the CRM seed changed since run ${run.runId} (sha256 ${seedHash.slice(0, 12)}, run used ${run.seed.sha256.slice(0, 12)}); designed causes may differ.`,
    );
  }
  const lines = readJsonl<InvestigationOutputLine>(join(runDir, "outputs.jsonl"));
  const metrics = computeInvestigationMetrics(lines, causeLabels(seedPath, options.datasetPath));
  writeFileSync(join(runDir, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
  writeFileSync(join(runDir, "report.md"), renderInvestigationMarkdown(run, metrics));
  writeFileSync(join(runDir, "report.html"), renderInvestigationHtml(run, metrics));
  return metrics;
}
