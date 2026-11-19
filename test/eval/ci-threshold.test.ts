// The CI threshold (P12): intent ≥ 16/18 and no missed must-review message, on a complete
// small-subset run. checkRun on hand-made metrics; eval:check on real stored outputs.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRun, MIN_INTENT_CORRECT, type Verdict } from "../../eval/ci-threshold.js";
import { main, parseCheckArgs } from "../../eval/check.js";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import type { Metrics } from "../../eval/metrics/aggregate.js";
import type { OutputLine } from "../../eval/metrics/types.js";
import { writeReports } from "../../eval/report/index.js";
import type { RunInfo } from "../../eval/run.js";
import { readSmallSubset } from "../../eval/subsets.js";

const IDS = Array.from({ length: 18 }, (_, i) => `msg-${i}`);

function metrics(intentCorrect: number, mustReview = { labelled: 8, fn: 0 }, n = 18) {
  const tp = mustReview.labelled - mustReview.fn;
  return {
    n,
    overall: {
      intentAccuracy: Number((intentCorrect / n).toFixed(4)),
      routing: { mustReview: { labelled: mustReview.labelled, tp, fn: mustReview.fn } },
    },
  } as unknown as Pick<Metrics, "n" | "overall">;
}
const info = (over: Partial<RunInfo> = {}) => ({ set: "small" as const, complete: true, ids: IDS, ...over });
const failed = (v: Verdict) =>
  v.checks
    .filter((c) => !c.pass)
    .map((c) => c.name)
    .sort();

describe("checkRun", () => {
  it("passes 18/18 and 16/18 with every must-review message in review", () => {
    expect(MIN_INTENT_CORRECT).toBe(16);
    expect(checkRun(info(), metrics(18)).pass).toBe(true);
    expect(checkRun(info(), metrics(16)).pass).toBe(true);
  });

  it("fails 15/18 right intents", () => {
    const v = checkRun(info(), metrics(15));
    expect(v.pass).toBe(false);
    expect(failed(v)).toEqual(["intent"]);
    expect(v.checks.find((c) => c.name === "intent")?.detail).toBe("15 of 18 intents right; at least 16 required");
  });

  it("fails one missed must-review message, even with every intent right", () => {
    const v = checkRun(info(), metrics(18, { labelled: 8, fn: 1 }));
    expect(failed(v)).toEqual(["must_review"]);
  });

  it("fails a run with no must-review label or no routing metrics", () => {
    expect(failed(checkRun(info(), metrics(18, { labelled: 0, fn: 0 })))).toEqual(["must_review"]);
    const noRouting = { n: 18, overall: { intentAccuracy: 1 } } as unknown as Pick<Metrics, "n" | "overall">;
    expect(failed(checkRun(info(), noRouting))).toEqual(["must_review"]);
  });

  it("fails an incomplete run", () => {
    expect(failed(checkRun(info({ complete: false }), metrics(12, undefined, 12)))).toContain("complete");
    // Marked complete but fewer messages scored than planned.
    expect(failed(checkRun(info(), metrics(17, undefined, 17)))).toEqual(["complete"]);
  });

  it("fails a full run", () => {
    expect(failed(checkRun(info({ set: "full" }), metrics(18)))).toEqual(["set"]);
  });

  it("raises the bar with an override", () => {
    expect(checkRun(info(), metrics(18), { minIntentCorrect: 19 }).pass).toBe(false);
    expect(checkRun(info(), metrics(17), { minIntentCorrect: 17 }).pass).toBe(true);
  });
});

describe("eval:check arguments", () => {
  it("parses a run, the override and the summary file in any order", () => {
    expect(parseCheckArgs(["r"])).toEqual({ ref: "r", minIntentCorrect: undefined, summaryFile: undefined });
    expect(parseCheckArgs(["--summary", "s.md", "r", "--min-intent-correct", "19"])).toEqual({
      ref: "r",
      minIntentCorrect: 19,
      summaryFile: "s.md",
    });
    // An unset workflow_dispatch input arrives as an empty string: use the code's threshold.
    expect(parseCheckArgs(["r", "--min-intent-correct", ""]).minIntentCorrect).toBeUndefined();
  });

  it("rejects bad arguments", () => {
    expect(() => parseCheckArgs([])).toThrow(/Usage/);
    expect(() => parseCheckArgs(["a", "b"])).toThrow(/Usage/);
    expect(() => parseCheckArgs(["r", "--summary"])).toThrow(/Usage/);
    expect(() => parseCheckArgs(["r", "--min-intent-correct", "1.5"])).toThrow(/whole number/);
  });
});

/**
 * A small-subset run built from the kept full classify.v2 run's outputs for the 18 subset
 * messages, scored against the real dataset and CRM seed: the same model and prompt as a
 * CI run, without a model call.
 */
async function smallRunFromKept(edit: (line: OutputLine) => OutputLine = (l) => l): Promise<string> {
  const kept = join(PATHS.results, "kept", "20261119-010458-full-claude-opus-5-5-classify.v2");
  const keptInfo = JSON.parse(readFileSync(join(kept, "run.json"), "utf8")) as RunInfo;
  const ids = readSmallSubset().ids;
  const lines = readJsonl<OutputLine>(join(kept, "outputs.jsonl")).filter((l) => ids.includes(l.id));
  expect(lines).toHaveLength(18);
  const runId = "20261120-000000-small-claude-opus-5-5-classify.v2";
  const dir = join(mkdtempSync(join(tmpdir(), "eval-check-")), runId);
  mkdirSync(dir);
  writeFileSync(join(dir, "run.json"), JSON.stringify({ ...keptInfo, runId, set: "small", ids }, null, 2) + "\n");
  writeFileSync(join(dir, "outputs.jsonl"), lines.map((l) => JSON.stringify(edit(l))).join("\n") + "\n");
  // The default CRM seed (eval/data/crm/seed.json), as in eval:report.
  await writeReports(dir, { datasetPath: PATHS.dataset, log: () => {} });
  return dir;
}

describe("eval:check on stored outputs", () => {
  it("passes the kept classify.v2 outputs for the small subset, and writes the summary", async () => {
    const dir = await smallRunFromKept();
    const summary = join(dir, "..", "summary.md");
    const out: string[] = [];
    expect(main([dir, "--summary", summary], { log: (t) => out.push(t) })).toBe(0);
    expect(out.join("")).toContain("## Evaluation threshold: passed");
    expect(readFileSync(summary, "utf8")).toContain("| intent | pass | 18 of 18 intents right; at least 16 required |");
  });

  it("exits 1 when the bar is raised above the subset, as the manual red CI run does", async () => {
    const dir = await smallRunFromKept();
    const out: string[] = [];
    expect(main([dir, "--min-intent-correct", "19"], { log: (t) => out.push(t) })).toBe(1);
    expect(out.join("")).toContain("## Evaluation threshold: FAILED");
  });

  it("exits 1 when three cancellations are read as billing questions", async () => {
    const labels = new Map(
      readJsonl<{ id: string; final: { intent: string } }>(PATHS.dataset).map((r) => [r.id, r.final.intent]),
    );
    const dir = await smallRunFromKept((l) =>
      labels.get(l.id) === "cancellation" && l.attempt.classification
        ? {
            ...l,
            attempt: {
              ...l.attempt,
              classification: { ...l.attempt.classification, intent: "billing_question", confidence: 0.9 },
            },
          }
        : l,
    );
    const out: string[] = [];
    expect(main([dir], { log: (t) => out.push(t) })).toBe(1);
    expect(out.join("")).toMatch(/\| intent \| \*\*fail\*\* \| 15 of 18/);
    expect(out.join("")).toMatch(/\| must_review \| \*\*fail\*\* \|/);
  });

  it("exits 1 for a missing run", () => {
    const errors: string[] = [];
    expect(main(["no-such-run"], { error: (t) => errors.push(t) })).toBe(1);
    expect(errors[0]).toMatch(/No run "no-such-run"/);
  });
});
