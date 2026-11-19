// The pass threshold for the small evaluation subset in CI (P12 requirements.md, The threshold).
// Pure: it reads a run's run.json and metrics.json, never a model.
//
// Thresholds are message counts, not percentages, so changing the subset can't silently loosen
// them: 16 of 18 leaves room for one or two wobbles of a non-deterministic model, and a
// must-review message that is auto-routed is never tolerated.

import type { Metrics } from "./metrics/aggregate.js";
import type { RunInfo } from "./run.js";

export const MIN_INTENT_CORRECT = 16;
/** Must-review messages the run may auto-route. */
export const MAX_MUST_REVIEW_MISSED = 0;

export interface Check {
  name: "set" | "complete" | "intent" | "must_review";
  pass: boolean;
  detail: string;
}

export interface Verdict {
  pass: boolean;
  checks: Check[];
}

export interface ThresholdOverrides {
  /** Raises (or lowers) the intent bar; used only by the manual CI run that shows the red path. */
  minIntentCorrect?: number;
}

export function checkRun(
  info: Pick<RunInfo, "set" | "complete" | "ids">,
  metrics: Pick<Metrics, "n" | "overall">,
  overrides: ThresholdOverrides = {},
): Verdict {
  const minIntent = overrides.minIntentCorrect ?? MIN_INTENT_CORRECT;
  const n = metrics.n;
  // intentAccuracy is rounded to 4 decimals; n ≤ 10 000 makes the count exact.
  const intentCorrect = Math.round((metrics.overall.intentAccuracy ?? 0) * n);
  const mustReview = metrics.overall.routing?.mustReview;

  const checks: Check[] = [
    {
      name: "set",
      pass: info.set === "small",
      detail: `set is ${info.set}; the threshold is defined for the small subset`,
    },
    {
      name: "complete",
      pass: info.complete && n === info.ids.length,
      detail: info.complete
        ? `${n} of ${info.ids.length} messages scored`
        : `run incomplete (${n} of ${info.ids.length} messages); a partial run can't pass`,
    },
    {
      name: "intent",
      pass: intentCorrect >= minIntent,
      detail: `${intentCorrect} of ${n} intents right; at least ${minIntent} required`,
    },
    mustReview === undefined
      ? { name: "must_review", pass: false, detail: "no routing metrics in this run; recompute it with eval:report" }
      : {
          name: "must_review",
          pass: mustReview.labelled > 0 && mustReview.fn <= MAX_MUST_REVIEW_MISSED,
          detail:
            mustReview.labelled === 0
              ? "no message labelled must-review; recall can't be checked"
              : `${mustReview.tp} of ${mustReview.labelled} must-review messages sent to review; all required`,
        },
  ];
  return { pass: checks.every((c) => c.pass), checks };
}

export function verdictMarkdown(runId: string, verdict: Verdict): string {
  return [
    `## Evaluation threshold: ${verdict.pass ? "passed" : "FAILED"}`,
    "",
    `Run \`${runId}\`.`,
    "",
    "| Check | Result | Detail |",
    "| --- | --- | --- |",
    ...verdict.checks.map((c) => `| ${c.name} | ${c.pass ? "pass" : "**fail**"} | ${c.detail} |`),
    "",
  ].join("\n");
}
