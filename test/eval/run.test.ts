// The eval runner over the real small subset with a mocked client: no model calls.

import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import type { OutputLine } from "../../eval/metrics/types.js";
import { runEval, type RunInfo } from "../../eval/run.js";
import type { DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import { readSmallSubset } from "../../eval/subsets.js";
import type { LlmClient, LlmRequest, LlmResult } from "../../src/llm/client.js";
import { VALID_CLASSIFICATION } from "../support/attempts.js";

const JUDGE_OK = { faithful: 5, complete: 4, contains_personal_data: false, reason: "Fine." };
const USAGE = { input_tokens: 5000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function mockClient(classifyText = JSON.stringify(VALID_CLASSIFICATION)) {
  const calls: LlmRequest[] = [];
  const llm: LlmClient = {
    complete(req): Promise<LlmResult> {
      calls.push(req);
      const text = req.model === "claude-haiku-5-5" ? JSON.stringify(JUDGE_OK) : classifyText;
      return Promise.resolve({ ok: true, text, model: req.model, usage: USAGE });
    },
  };
  return { llm, calls };
}

function setup(classifyText?: string) {
  const resultsDir = mkdtempSync(join(tmpdir(), "eval-run-"));
  const { llm, calls } = mockClient(classifyText);
  const log: string[] = [];
  let t = Date.parse("2026-11-19T10:00:00Z");
  const deps = {
    createLlm: () => llm,
    env: {},
    resultsDir,
    clock: () => new Date((t += 1000)),
    git: () => ({ commit: "f".repeat(40), dirty: false }),
    log: (l: string) => log.push(l),
  };
  return { resultsDir, calls, log, deps };
}

const subset = readSmallSubset().ids;

describe("npm run eval", () => {
  it("--dry-run prints the plan, makes no call and writes nothing", async () => {
    const { resultsDir, calls, log, deps } = setup();
    expect(await runEval(["--subset", "small", "--dry-run"], deps)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(readdirSync(resultsDir)).toEqual([]);
    expect(log.join("\n")).toMatch(/18 jobs, 36 model calls/);
    expect(log.join("\n")).toMatch(/Estimated cost: \$\d+\.\d\d/);
  });

  it("classifies and grades the subset and writes every file", async () => {
    const { calls, deps } = setup();
    const runDir = (await runEval(["--subset", "small", "--yes", "--concurrency", "3"], deps))!;
    expect(runDir).toMatch(/20261119-100001-small-claude-opus-5-5-classify\.v1$/);
    for (const f of ["run.json", "outputs.jsonl", "metrics.json", "report.md", "report.html"]) {
      expect(existsSync(join(runDir, f)), f).toBe(true);
    }
    expect(calls.filter((c) => c.model === "claude-opus-5-5")).toHaveLength(18);
    expect(calls.filter((c) => c.model === "claude-haiku-5-5")).toHaveLength(18);

    const lines = readJsonl<OutputLine>(join(runDir, "outputs.jsonl"));
    expect(lines.map((l) => l.id)).toEqual([...subset].sort());
    expect(lines.every((l) => l.attempt.outcome === "valid" && l.judge?.outcome === "graded")).toBe(true);

    // No message text in the run files.
    const outputs = readFileSync(join(runDir, "outputs.jsonl"), "utf8");
    const dataset = readJsonl<DatasetRecord>(PATHS.dataset);
    for (const id of subset) expect(outputs).not.toContain(dataset.find((r) => r.id === id)!.text.slice(0, 60));

    const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunInfo;
    expect(run).toMatchObject({
      set: "small",
      complete: true,
      classifier: { model: "claude-opus-5-5", effort: "low", promptVersion: "classify.v1" },
      judge: { model: "claude-haiku-5-5", effort: "low", promptVersion: "summary-judge.v1" },
      dataset: { file: "eval/data/dataset.jsonl" },
      subset: { file: "eval/data/subsets/small.json" },
      git: { commit: "f".repeat(40), dirty: false },
    });
    expect(run.classifier.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(run.dataset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(run.guard?.jobsDone).toBe(18);
    const metrics = JSON.parse(readFileSync(join(runDir, "metrics.json"), "utf8")) as { n: number };
    expect(metrics.n).toBe(18);
  });

  it("makes no judge call for invalid classifications", async () => {
    const { calls, deps } = setup("not json {");
    const runDir = (await runEval(["--subset", "small", "--yes"], deps))!;
    expect(calls.every((c) => c.model === "claude-opus-5-5")).toBe(true);
    const lines = readJsonl<OutputLine>(join(runDir, "outputs.jsonl"));
    expect(lines.every((l) => l.attempt.outcome === "invalid" && l.judge === null)).toBe(true);
  });

  it("stops at the budget cap, keeps finished lines and marks the run incomplete", async () => {
    const { deps, log } = setup();
    // Each mocked classification costs $0.03; the second one no longer fits under $0.05.
    const runDir = (await runEval(["--subset", "small", "--yes", "--concurrency", "1", "--max-cost", "0.05"], deps))!;
    const lines = readJsonl<OutputLine>(join(runDir, "outputs.jsonl"));
    expect(lines).toHaveLength(1);
    const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunInfo;
    expect(run.complete).toBe(false);
    expect(run.guard?.stoppedByBudget).toBe(true);
    expect(log.join("\n")).toMatch(/Stopped: Budget cap/);
    expect(readFileSync(join(runDir, "report.md"), "utf8")).toContain("**no**: 1 of 18 messages finished");
  });

  it("refuses a real run without ANTHROPIC_API_KEY", async () => {
    const { deps } = setup();
    await expect(runEval(["--subset", "small", "--yes"], { ...deps, createLlm: undefined })).rejects.toThrow(
      /Missing ANTHROPIC_API_KEY/,
    );
  });

  it("rejects an unknown subset", async () => {
    const { deps } = setup();
    await expect(runEval(["--subset", "tiny", "--dry-run"], deps)).rejects.toThrow(/Unknown subset "tiny"/);
  });
});
