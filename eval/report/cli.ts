// npm run eval:report -- <run-id | path>: recomputes metrics.json, report.md and report.html
// of an existing run from its stored outputs: a classify run (P04), an investigation run (P10)
// or an injection run (P11).
// No model calls.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PATHS } from "../lib/paths.js";
import { readFileSync } from "node:fs";
import { isInjectionRun, writeInjectionReports } from "../injection/report.js";
import { isInvestigationRun, writeInvestigationReports } from "../investigate/report.js";
import { writeReports } from "./index.js";

/** A run id is looked up in eval/results/ and eval/results/kept/; a path is used as given. */
export function resolveRunDir(ref: string, resultsDir = PATHS.results): string {
  for (const candidate of [ref, join(resultsDir, ref), join(resultsDir, "kept", ref)]) {
    if (existsSync(join(candidate, "run.json"))) return candidate;
  }
  throw new Error(`No run "${ref}" in ${resultsDir} or ${join(resultsDir, "kept")}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  (async () => {
    const ref = process.argv[2];
    if (!ref) throw new Error("Usage: npm run eval:report -- <run-id>");
    const dir = resolveRunDir(ref);
    // An investigation run (P10) has its own metrics and report.
    const run: unknown = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    const m = isInjectionRun(run)
      ? await writeInjectionReports(dir, { injectionPath: PATHS.injection })
      : isInvestigationRun(run)
        ? writeInvestigationReports(dir, { datasetPath: PATHS.dataset })
        : await writeReports(dir, { datasetPath: PATHS.dataset });
    console.log(`Rewrote metrics.json, report.md and report.html in ${dir} (n=${m.n}).`);
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
