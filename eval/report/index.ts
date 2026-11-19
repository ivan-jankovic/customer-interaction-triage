// Writes metrics.json, report.md and report.html for a run folder from its run.json,
// outputs.jsonl and the dataset. No model calls and no clock, so the same inputs always
// give the same bytes (P04, "Reproducibility").

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256File } from "../lib/hash.js";
import { readJsonl } from "../lib/jsonl.js";
import { computeMetrics, type Metrics } from "../metrics/aggregate.js";
import { scoreMessage } from "../metrics/score.js";
import type { OutputLine } from "../metrics/types.js";
import type { RunInfo } from "../run.js";
import type { DatasetRecord } from "../schema/dataset-record.schema.js";
import { renderHtml } from "./html.js";
import { renderMarkdown } from "./markdown.js";

export interface WriteReportsOptions {
  datasetPath: string;
  log?: (line: string) => void;
}

export function buildMetrics(run: RunInfo, lines: readonly OutputLine[], dataset: readonly DatasetRecord[]): Metrics {
  const byId = new Map(dataset.map((r) => [r.id, r]));
  const sorted = [...lines].sort((a, b) => a.id.localeCompare(b.id));
  const scores = sorted.map((line) => {
    const record = byId.get(line.id);
    if (!record?.final)
      throw new Error(`Run ${run.runId}: message ${line.id} is not in the dataset or has no final labels.`);
    return scoreMessage(line.id, record.language, record.final, line.attempt);
  });
  return computeMetrics(scores, sorted);
}

export function writeReports(runDir: string, options: WriteReportsOptions): Metrics {
  const log = options.log ?? console.log;
  const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunInfo;
  const hash = sha256File(options.datasetPath);
  if (hash !== run.dataset.sha256) {
    log(
      `Warning: the dataset changed since run ${run.runId} (sha256 ${hash.slice(0, 12)}, run used ${run.dataset.sha256.slice(0, 12)}); labels may differ from the ones the run was scored against.`,
    );
  }
  const lines = readJsonl<OutputLine>(join(runDir, "outputs.jsonl"));
  const metrics = buildMetrics(run, lines, readJsonl<DatasetRecord>(options.datasetPath));
  writeFileSync(join(runDir, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
  writeFileSync(join(runDir, "report.md"), renderMarkdown(run, metrics));
  writeFileSync(join(runDir, "report.html"), renderHtml(run, metrics));
  return metrics;
}
