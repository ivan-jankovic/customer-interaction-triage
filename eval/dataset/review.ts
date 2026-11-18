// Step 4 of the dataset procedure: the interactive human review.
// Shows every message that needs review (disagreement, invalid grader output, the random
// agreement sample, and every injection message) with the chosen labels and both graders'
// labels side by side. Each decision is appended to the review log immediately, so the
// session can be stopped (q) and resumed at any time.
//
// Usage: npm run dataset:review   (run it in your own terminal; it is interactive)

import { createInterface } from "node:readline/promises";
import { appendJsonl } from "../lib/jsonl.js";
import { PATHS } from "../lib/paths.js";
import { assemble, readWorkFiles, reviewQueue } from "./assemble.js";
import { reviewLoop } from "./review-state.js";

async function main(): Promise<void> {
  if (!process.stdin.isTTY) throw new Error("dataset:review is interactive; run it in a terminal.");
  const assembly = assemble(readWorkFiles());
  const queue = reviewQueue(assembly);
  const pendingRewrites = assembly.records.filter((a) => a.rewritePending).map((a) => a.record.id);
  const notGraded = assembly.records.filter((a) => !a.fullyGraded).map((a) => a.record.id);
  console.log(`${queue.length} messages to review.`);
  if (pendingRewrites.length) console.log(`Waiting for rewrite (run generate + grade with --only): ${pendingRewrites.join(", ")}`);
  if (notGraded.length) console.log(`Not graded yet: ${notGraded.join(", ")}`);
  if (queue.length === 0) return;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const made = await reviewLoop(queue, { ask: (q) => rl.question(q), print: (l) => console.log(l) }, (e) => appendJsonl(PATHS.reviewLog, e));
    console.log(`\n${made} decisions saved to ${PATHS.reviewLog}. ${queue.length - made} left in this session's queue.`);
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
