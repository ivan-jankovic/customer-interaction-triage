// Step 5 of the dataset procedure: writes eval/data/dataset.jsonl and injection.jsonl.
// Refuses to write anything while a message is not generated, not graded, waiting for a
// rewrite or waiting for review, or while any record fails validation.
//
// Usage: npm run dataset:finalize

import { pathToFileURL } from "node:url";
import { writeJsonl } from "../lib/jsonl.js";
import { PATHS } from "../lib/paths.js";
import { recordErrors } from "../schema/validate.js";
import { assemble, readWorkFiles, reviewQueue, type Assembly } from "./assemble.js";

export function finalizeProblems(assembly: Assembly): string[] {
  const problems: string[] = [];
  if (assembly.notGenerated.length) problems.push(`not generated: ${assembly.notGenerated.join(", ")}`);
  const notGraded = assembly.records.filter((a) => !a.fullyGraded).map((a) => a.record.id);
  if (notGraded.length) problems.push(`not graded: ${notGraded.join(", ")}`);
  const rewrites = assembly.records.filter((a) => a.rewritePending).map((a) => a.record.id);
  if (rewrites.length) problems.push(`waiting for rewrite: ${rewrites.join(", ")}`);
  const queue = reviewQueue(assembly).map((a) => a.record.id);
  if (queue.length) problems.push(`waiting for review: ${queue.join(", ")}`);
  for (const a of assembly.records) {
    if (a.record.final === null && !queue.includes(a.record.id) && !a.rewritePending && a.fullyGraded) {
      problems.push(`${a.record.id}: no final labels`);
    }
    for (const e of recordErrors(a.record)) problems.push(`${a.record.id}: ${e}`);
  }
  return problems;
}

function main(): void {
  const assembly = assemble(readWorkFiles());
  const problems = finalizeProblems(assembly);
  if (problems.length) {
    console.error("Not finalized:");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  const records = assembly.records.map((a) => a.record);
  const dataset = records.filter((r) => r.id.startsWith("msg-")).sort((a, b) => a.id.localeCompare(b.id));
  const injection = records.filter((r) => r.id.startsWith("inj-")).sort((a, b) => a.id.localeCompare(b.id));
  writeJsonl(PATHS.dataset, dataset);
  writeJsonl(PATHS.injection, injection);
  console.log(`Wrote ${dataset.length} records to ${PATHS.dataset} and ${injection.length} to ${PATHS.injection}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
