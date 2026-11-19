// Reports from the 8-message fixture: golden Markdown, byte-for-byte reproducibility,
// a self-contained HTML page, and the dataset-changed warning.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256File } from "../../eval/lib/hash.js";
import { writeReports } from "../../eval/report/index.js";
import type { RunInfo } from "../../eval/run.js";
import { FIXTURE } from "./fixtures/eval-fixture.js";

const GOLDEN = join(import.meta.dirname, "fixtures", "report.md");

/** A run folder and dataset file built from the fixture, in a fresh temp folder. */
function fixtureRun(): { runDir: string; datasetPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "eval-report-"));
  const datasetPath = join(dir, "dataset.jsonl");
  writeFileSync(
    datasetPath,
    FIXTURE.map((m) => JSON.stringify({ id: m.id, channel: m.channel, language: m.language, final: m.labels })).join(
      "\n",
    ) + "\n",
  );
  const run: RunInfo = {
    runId: "20261119-120000-full-claude-opus-5-5-classify.v1",
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
  };
  const runDir = join(dir, run.runId);
  mkdirSync(runDir);
  writeFileSync(join(runDir, "run.json"), JSON.stringify(run, null, 2) + "\n");
  writeFileSync(join(runDir, "outputs.jsonl"), FIXTURE.map((m) => JSON.stringify(m.line)).join("\n") + "\n");
  return { runDir, datasetPath };
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

describe("writeReports", () => {
  it("renders report.md exactly like the golden file", () => {
    const { runDir, datasetPath } = fixtureRun();
    writeReports(runDir, { datasetPath, log: () => {} });
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, read(runDir, "report.md"));
    expect(read(runDir, "report.md")).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("reproduces metrics.json, report.md and report.html byte for byte", () => {
    const { runDir, datasetPath } = fixtureRun();
    writeReports(runDir, { datasetPath, log: () => {} });
    const first = ["metrics.json", "report.md", "report.html"].map((f) => read(runDir, f));
    writeReports(runDir, { datasetPath, log: () => {} });
    expect(["metrics.json", "report.md", "report.html"].map((f) => read(runDir, f))).toEqual(first);
  });

  it("writes a self-contained HTML page with light and dark tokens", () => {
    const { runDir, datasetPath } = fixtureRun();
    writeReports(runDir, { datasetPath, log: () => {} });
    const html = read(runDir, "report.html");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/(src|href)=["']?https?:/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain('<meta name="viewport"');
    // The summaries of wrong intents appear, escaped.
    expect(html).toContain("Summary for complaint.");
  });

  it("warns when the dataset changed since the run", () => {
    const { runDir, datasetPath } = fixtureRun();
    writeFileSync(datasetPath, readFileSync(datasetPath, "utf8") + "\n");
    const log: string[] = [];
    writeReports(runDir, { datasetPath, log: (l) => log.push(l) });
    expect(log.join("\n")).toMatch(/Warning: the dataset changed since run/);
  });
});
