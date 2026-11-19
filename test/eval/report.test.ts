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
  it("renders report.md exactly like the golden file", async () => {
    const { runDir, datasetPath, crmSeedPath } = fixtureRun();
    await writeReports(runDir, { datasetPath, crmSeedPath, log: () => {} });
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, read(runDir, "report.md"));
    expect(read(runDir, "report.md")).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("reproduces metrics.json, report.md and report.html byte for byte", async () => {
    const { runDir, datasetPath, crmSeedPath } = fixtureRun();
    await writeReports(runDir, { datasetPath, crmSeedPath, log: () => {} });
    const first = ["metrics.json", "report.md", "report.html"].map((f) => read(runDir, f));
    await writeReports(runDir, { datasetPath, crmSeedPath, log: () => {} });
    expect(["metrics.json", "report.md", "report.html"].map((f) => read(runDir, f))).toEqual(first);
  });

  it("writes a self-contained HTML page with light and dark tokens", async () => {
    const { runDir, datasetPath, crmSeedPath } = fixtureRun();
    await writeReports(runDir, { datasetPath, crmSeedPath, log: () => {} });
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

  it("warns when the dataset changed since the run", async () => {
    const { runDir, datasetPath, crmSeedPath } = fixtureRun();
    writeFileSync(datasetPath, readFileSync(datasetPath, "utf8") + "\n");
    const log: string[] = [];
    await writeReports(runDir, { datasetPath, crmSeedPath, log: (l) => log.push(l) });
    expect(log.join("\n")).toMatch(/Warning: the dataset changed since run/);
  });
});
