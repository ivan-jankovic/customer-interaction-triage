// Builds a run folder and dataset file from the 8-message fixture, for report and compare tests.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256File } from "../../../eval/lib/hash.js";
import type { OutputLine } from "../../../eval/metrics/types.js";
import type { RunInfo } from "../../../eval/run.js";
import { FIXTURE } from "./eval-fixture.js";

/** A run folder and dataset file built from the fixture, in a fresh temp folder. */
export function fixtureRun(
  options: { runId?: string; run?: Partial<RunInfo>; lines?: (line: OutputLine) => OutputLine } = {},
): { runDir: string; datasetPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "eval-report-"));
  const datasetPath = join(dir, "dataset.jsonl");
  writeFileSync(
    datasetPath,
    FIXTURE.map((m) => JSON.stringify({ id: m.id, channel: m.channel, language: m.language, final: m.labels })).join(
      "\n",
    ) + "\n",
  );
  const run: RunInfo = {
    runId: options.runId ?? "20261119-120000-full-claude-opus-5-5-classify.v1",
    set: "full",
    ids: FIXTURE.map((m) => m.id),
    startedAt: "2026-11-19T12:00:00.000Z",
    finishedAt: "2026-11-19T12:01:00.000Z",
    complete: true,
    classifier: { model: "claude-opus-5-5", effort: "low", promptVersion: "classify.v1", promptSha256: "a".repeat(64) },
    judge: {
      model: "claude-haiku-5-5",
      effort: "low",
      promptVersion: "summary-judge.v1",
      promptSha256: "b".repeat(64),
    },
    dataset: { file: "eval/data/dataset.jsonl", sha256: sha256File(datasetPath) },
    subset: null,
    git: { commit: "0123456789abcdef0123456789abcdef01234567", dirty: false },
    options: { maxCost: 3, concurrency: 4 },
    guard: null,
    ...options.run,
  };
  const runDir = join(dir, run.runId);
  mkdirSync(runDir);
  writeFileSync(join(runDir, "run.json"), JSON.stringify(run, null, 2) + "\n");
  writeFileSync(
    join(runDir, "outputs.jsonl"),
    FIXTURE.map((m) => JSON.stringify((options.lines ?? ((l) => l))(m.line))).join("\n") + "\n",
  );
  return { runDir, datasetPath };
}
