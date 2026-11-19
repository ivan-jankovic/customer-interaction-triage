// npm run eval:check -- <run-id | path> [--min-intent-correct n] [--summary file]
//
// Checks a stored small-subset run against the CI threshold (P12) and exits 1 when it fails.
// Free: reads run.json and metrics.json only. --summary appends the verdict as Markdown to a
// file (in CI, $GITHUB_STEP_SUMMARY).

import { appendFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkRun, verdictMarkdown, type Verdict } from "./ci-threshold.js";
import type { Metrics } from "./metrics/aggregate.js";
import { resolveRunDir } from "./report/cli.js";
import type { RunInfo } from "./run.js";

export interface CheckArgs {
  ref: string;
  minIntentCorrect: number | undefined;
  summaryFile: string | undefined;
}

const USAGE = "Usage: npm run eval:check -- <run-id> [--min-intent-correct n] [--summary file]";

export function parseCheckArgs(args: readonly string[]): CheckArgs {
  const rest = [...args];
  const take = (flag: string): string | undefined => {
    const i = rest.indexOf(flag);
    if (i < 0) return undefined;
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
    rest.splice(i, 2);
    return value;
  };
  const min = take("--min-intent-correct");
  const summaryFile = take("--summary");
  if (rest.length !== 1) throw new Error(USAGE);
  // An empty value (an unset workflow input) means "use the code's threshold".
  let minIntentCorrect: number | undefined;
  if (min !== undefined && min.trim() !== "") {
    minIntentCorrect = Number(min);
    if (!Number.isInteger(minIntentCorrect) || minIntentCorrect < 0)
      throw new Error("--min-intent-correct must be a whole number of messages");
  }
  return { ref: rest[0]!, minIntentCorrect, summaryFile };
}

/** Checks the run and writes the verdict; returns it so the caller sets the exit code. */
export function checkRunDir(
  dir: string,
  options: { minIntentCorrect?: number; summaryFile?: string; log?: (text: string) => void } = {},
): Verdict {
  const info = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as RunInfo;
  const metrics = JSON.parse(readFileSync(join(dir, "metrics.json"), "utf8")) as Metrics;
  const verdict = checkRun(
    info,
    metrics,
    options.minIntentCorrect === undefined ? {} : { minIntentCorrect: options.minIntentCorrect },
  );
  const markdown = verdictMarkdown(info.runId || basename(dir), verdict);
  (options.log ?? ((t: string) => process.stdout.write(t)))(markdown);
  if (options.summaryFile) appendFileSync(options.summaryFile, markdown + "\n");
  return verdict;
}

/** The command: returns the exit code (0 passed, 1 failed or bad arguments). */
export function main(
  argv: readonly string[],
  io: { log?: (text: string) => void; error?: (text: string) => void } = {},
): number {
  try {
    const args = parseCheckArgs(argv);
    const verdict = checkRunDir(resolveRunDir(args.ref), {
      ...(args.minIntentCorrect === undefined ? {} : { minIntentCorrect: args.minIntentCorrect }),
      ...(args.summaryFile === undefined ? {} : { summaryFile: args.summaryFile }),
      ...(io.log ? { log: io.log } : {}),
    });
    return verdict.pass ? 0 : 1;
  } catch (error) {
    (io.error ?? console.error)(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
