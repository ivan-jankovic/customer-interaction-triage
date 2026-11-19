// eval:compare on two fixture runs: the second has masking and gets m7's intent right.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareRunDirs, parseCompareArgs } from "../../eval/compare.js";
import { writeReports } from "../../eval/report/index.js";
import { fixtureRun } from "./fixtures/fixture-run.js";

const GOLDEN = join(import.meta.dirname, "fixtures", "compare.md");

function runs() {
  const a = fixtureRun();
  const b = fixtureRun({
    runId: "20261119-130000-full-claude-opus-5-5-classify.v2",
    run: {
      classifier: {
        model: "claude-opus-5-5",
        effort: "low",
        promptVersion: "classify.v2",
        promptSha256: "c".repeat(64),
      },
      masker: { version: "mask.v1" },
    },
    lines: (l) =>
      l.id === "m7" && l.attempt.classification
        ? {
            ...l,
            attempt: { ...l.attempt, classification: { ...l.attempt.classification, intent: "technical_fault" } },
          }
        : l,
  });
  for (const r of [a, b]) writeReports(r.runDir, { datasetPath: r.datasetPath, log: () => {} });
  return { a, b };
}

describe("eval:compare", () => {
  it("renders settings, headline metrics with changes and per-language rows (golden)", () => {
    const { a, b } = runs();
    const md = compareRunDirs(a.runDir, b.runDir);
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, md);
    expect(md).toBe(readFileSync(GOLDEN, "utf8"));
    expect(md).toContain("| Masking | none | mask.v1 |");
    // m7 right in B: intent 4/8 → 5/8.
    expect(md).toContain("| Intent accuracy | 50.0% | 62.5% | +12.5 pp |");
    expect(md).not.toContain("**Warning:**");
  });

  it("warns when the runs cover different messages or datasets", () => {
    const { a } = runs();
    const other = fixtureRun({ run: { ids: ["m1", "m2"], dataset: { file: "x", sha256: "d".repeat(64) } } });
    writeReports(other.runDir, { datasetPath: other.datasetPath, log: () => {} });
    const md = compareRunDirs(a.runDir, other.runDir);
    expect(md).toContain("**Warning:** the runs cover different messages (8 vs 2)");
    expect(md).toContain("**Warning:** the runs used different dataset files");
  });

  it("parses two runs with or without --out", () => {
    expect(parseCompareArgs(["a", "b"])).toEqual({ refs: ["a", "b"], outFile: undefined });
    expect(parseCompareArgs(["a", "--out", "x.md", "b"])).toEqual({ refs: ["a", "b"], outFile: "x.md" });
    expect(() => parseCompareArgs(["a"])).toThrow(/Usage/);
    expect(() => parseCompareArgs(["a", "b", "--out"])).toThrow(/Usage/);
  });
});
