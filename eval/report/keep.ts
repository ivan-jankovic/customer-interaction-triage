// npm run eval:keep -- <run-id>: moves a run into eval/results/kept/, which is committed.
// Other runs stay out of git (P04, "Keeping runs").

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PATHS } from "../lib/paths.js";

export function keepRun(runId: string, resultsDir = PATHS.results): string {
  const from = join(resultsDir, runId);
  const to = join(resultsDir, "kept", runId);
  if (!existsSync(join(from, "run.json"))) throw new Error(`No run "${runId}" in ${resultsDir}.`);
  if (existsSync(to)) throw new Error(`${to} already exists.`);
  mkdirSync(join(resultsDir, "kept"), { recursive: true });
  renameSync(from, to);
  return to;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const id = process.argv[2];
    if (!id) throw new Error("Usage: npm run eval:keep -- <run-id>");
    console.log(`Kept: ${keepRun(id)} (commit it to keep it in the repository).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
