// Writes metrics.json, report.md and report.html for a run folder from its run.json,
// outputs.jsonl and the dataset. No model calls and no clock, so the same inputs always
// give the same bytes (P04, "Reproducibility"). Routing (P07) is scored by masking each
// message, enriching it against the in-memory CRM seed and routing it, so the seed is an input
// too; its hash is recorded in the metrics.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CRM_SEED_PATH, readCrmSeed } from "../../src/db/crm-seed.js";
import { ENRICHER_VERSION } from "../../src/pipeline/enrich.js";
import { ROUTER_VERSION } from "../../src/pipeline/route.js";
import { sha256File } from "../lib/hash.js";
import { readJsonl } from "../lib/jsonl.js";
import { makeMessageRouter } from "../lib/route-message.js";
import { computeMetrics, type Metrics } from "../metrics/aggregate.js";
import { scoreMessage } from "../metrics/score.js";
import type { OutputLine } from "../metrics/types.js";
import type { RunInfo } from "../run.js";
import type { DatasetRecord } from "../schema/dataset-record.schema.js";
import { renderHtml } from "./html.js";
import { renderMarkdown } from "./markdown.js";

export interface WriteReportsOptions {
  datasetPath: string;
  /** The mock CRM seed routing is scored against; eval/data/crm/seed.json by default. */
  crmSeedPath?: string;
  log?: (line: string) => void;
}

export async function buildMetrics(
  run: RunInfo,
  lines: readonly OutputLine[],
  dataset: readonly DatasetRecord[],
  crmSeedPath = CRM_SEED_PATH,
): Promise<Metrics> {
  const byId = new Map(dataset.map((r) => [r.id, r]));
  const router = makeMessageRouter(readCrmSeed(crmSeedPath));
  const sorted = [...lines].sort((a, b) => a.id.localeCompare(b.id));
  const scores = [];
  for (const line of sorted) {
    const record = byId.get(line.id);
    if (!record?.final)
      throw new Error(`Run ${run.runId}: message ${line.id} is not in the dataset or has no final labels.`);
    const routed = await router(record, line.attempt);
    scores.push(scoreMessage(line.id, record.language, record.final, line.attempt, routed));
  }
  return computeMetrics(scores, sorted, {
    enricherVersion: ENRICHER_VERSION,
    routerVersion: ROUTER_VERSION,
    seedSha256: sha256File(crmSeedPath),
  });
}

export async function writeReports(runDir: string, options: WriteReportsOptions): Promise<Metrics> {
  const log = options.log ?? console.log;
  const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunInfo;
  const hash = sha256File(options.datasetPath);
  if (hash !== run.dataset.sha256) {
    log(
      `Warning: the dataset changed since run ${run.runId} (sha256 ${hash.slice(0, 12)}, run used ${run.dataset.sha256.slice(0, 12)}); labels may differ from the ones the run was scored against.`,
    );
  }
  const lines = readJsonl<OutputLine>(join(runDir, "outputs.jsonl"));
  const metrics = await buildMetrics(run, lines, readJsonl<DatasetRecord>(options.datasetPath), options.crmSeedPath);
  writeFileSync(join(runDir, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
  writeFileSync(join(runDir, "report.md"), renderMarkdown(run, metrics));
  writeFileSync(join(runDir, "report.html"), renderHtml(run, metrics));
  return metrics;
}
