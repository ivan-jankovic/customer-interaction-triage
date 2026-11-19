// Reports from the 8-message fixture: golden Markdown, byte-for-byte reproducibility,
// a self-contained HTML page, and the dataset-changed warning.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeReports } from "../../eval/report/index.js";
import { fixtureRun } from "./fixtures/fixture-run.js";

const GOLDEN = join(import.meta.dirname, "fixtures", "report.md");

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
