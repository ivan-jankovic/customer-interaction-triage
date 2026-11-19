# Phase 4 — Evaluation harness and baseline: Requirements

## Context

This is phase P04 in [roadmap.md](../../roadmap.md). P03 left the understanding step (`src/pipeline/understand.ts`): one model call per message, validated with Ajv, returning a `valid`, `invalid` or `error` attempt with usage, cost and latency. Prompt `classify.v1` is versioned, with a hash registry. P00 left the labelled dataset (`eval/data/dataset.jsonl`, 100 messages with reviewed `final` labels) and a run guard for paid scripts (`eval/lib/run-guard.ts`).

P04 turns "it looked right on five messages" into numbers. It runs the understanding step over the dataset, scores it against the labels, and writes a report that later phases compare against: P05 (masking), P07 (routing) and P12 (prompt and model comparisons). This is the mission's principle "Measured, not assumed" ([mission.md](../../mission.md)). The first run, the **baseline**, is kept in the repository.

## Scope

In scope:

- **`npm run eval`.** It classifies the messages of a set with `understand()`, grades each valid summary with a judge model, scores everything against the `final` labels, and writes a run folder. The run guard handles `--dry-run`, confirmation, `--yes`, `--max-cost` and `--concurrency`.
- **Two sets:**
  - the full dataset (default, 100 messages);
  - `--subset small`: a fixed list of 18 messages in `eval/data/subsets/small.json`.
- **A summary judge.** Prompt `eval/prompts/summary-judge.v1.md` (versioned in the registry) runs on `claude-haiku-5-5`, and its output is validated with a JSON Schema.
- **Metrics,** overall and per language (cs, sk, en). They are defined under Metrics below.
- **Run output** in `eval/results/<run-id>/`: `run.json`, `outputs.jsonl`, `metrics.json`, `report.md` and `report.html`.
- **`npm run eval:report -- <run-id>`.** It recomputes `metrics.json`, `report.md` and `report.html` from the stored outputs and the dataset, with no model calls. The result is byte-identical to the original.
- **`npm run eval:keep -- <run-id>`.** It moves a run to `eval/results/kept/`, which is committed. Other runs are ignored by git.
- **The baseline:** one full run with the P03 defaults (`claude-opus-5-5`, effort `low`, `classify.v1`), kept and committed.
- **Tests:**
  - unit tests on fixtures with hand-computed values for every metric;
  - the runner with a mocked client;
  - report rendering and reproducibility;
  - the subset's composition.
- **Docs and constitution:**
  - [tech-stack.md](../../tech-stack.md): the CI evaluation subset moves from "from P04" to "from P12", and the evaluation section gets the run layout, the subset and the summary judge.
  - `README.md`: how to run an evaluation.
  - `eval/results/README.md`: the run format.
  - Approving this spec approves these edits.

Out of scope (later phases):

- The evaluation subset in CI, the API-key secret and a pass threshold (P12).
- Routing accuracy and recall on must-review (P07). The report leaves room for them, but P04 does not compute them.
- The effect of masking (P05), prompt or model comparisons (P12), and the injection report (P11).
- Repeated runs per message, self-consistency and full calibration metrics such as ECE, the Brier score and reliability diagrams (P17).
- Writing evaluation attempts to the database.

## Metrics

Ground truth is each record's `final` labels. `n` is the number of messages in the set; every metric says its `n`.

| Metric | Definition |
| --- | --- |
| Valid rate | Share of messages whose attempt is `valid`; `invalid` and `error` counts are listed separately, as are fallbacks. |
| Intent accuracy | Correct intent / `n`. An `invalid` or `error` attempt counts as wrong. |
| Per-intent precision and recall | For each of the six intents. Recall's denominator is the messages labelled with that intent; precision's is the valid predictions of it. |
| Macro F1 | The mean of the six per-intent F1 scores. |
| Confusion matrix | Rows are the labelled intents; columns are the predicted intents plus a column for `invalid / error`. |
| Urgency, language, service type accuracy | Exact match, over all `n` (invalid counts as wrong). |
| Area accuracy | Match after normalising case, diacritics and spaces (`normaliseArea`, as in the labelling guide); `null` = `null` counts as correct. |
| Identifiers | Micro precision and recall over `(type, value)` pairs, with values compared exactly as written; plus the share of messages whose whole identifier list is exactly right (as a set). |
| Summary quality | Over valid attempts the judge graded: mean `faithful` and mean `complete` (1–5), and the share with personal data in the summary. Judge failures are counted as "not graded". |
| Confidence | Mean confidence for correct vs. wrong intents, and the count and intent accuracy in four bands: `< 0.5`, `0.5–0.8`, `0.8–0.9`, `≥ 0.9`. |
| Cost | Total and per message in USD, for the classifier and the judge separately; tokens, including cache reads and writes. |
| Latency | p50, p95 and max of the classifier's `latency_ms`. |

- **Per-language breakdown.** Every accuracy metric is also given for cs, sk and en. A language with fewer than 30 messages is marked "indicative only" ([tech-stack.md](../../tech-stack.md), Languages).
- **Worst errors.** The report lists the wrong intents, sorted by confidence (highest first), with the message ID, the label, the prediction and the summary. These are the confident mistakes that matter most for P07.

## Run output

`eval/results/<run-id>/`, where `<run-id>` is `YYYYMMDD-HHMMSS-<set>-<model>-<prompt-version>` (in UTC):

| File | Content |
| --- | --- |
| `run.json` | Run ID, set and message IDs, model, effort, prompt version and its hash, judge model, prompt version and hash, dataset file hash, git commit (and whether the tree had uncommitted changes), start and end time, the run guard's totals and the command-line options |
| `outputs.jsonl` | One line per message, in ID order: the message ID, the full classification attempt (raw output, outcome, classification, errors, models, usage, cost, latency) and the judge result (raw output, scores or errors, usage, cost) |
| `metrics.json` | Every metric above, as computed from `outputs.jsonl` and the dataset |
| `report.md` | The metrics as Markdown tables, with the run's settings at the top |
| `report.html` | The same report as one self-contained page: inline CSS and SVG charts, with no external scripts or fonts, readable in light and dark mode |

- **Message text stays in the dataset.** The run files hold IDs, model output and scores, but no copy of the message text.
- **Reproducible files.** `metrics.json`, `report.md` and `report.html` depend only on `outputs.jsonl`, `run.json` and the dataset, with no clock or randomness at report time. That is what makes `eval:report` reproduce them exactly.
- **Changed labels.** If the dataset's hash differs from the one in `run.json`, `eval:report` warns, because the labels may have changed.

## Decisions

### Requirements

| Decision | Choice | Why |
| --- | --- | --- |
| Input | `eval/data/dataset.jsonl`, through `understand()` directly; no database | Runs don't depend on the dev database's state, and evaluation attempts don't mix with pipeline records. Decided during spec review. |
| Summary grading | Now, with a judge on `claude-haiku-5-5` at effort `low`, without fallbacks. It returns `faithful` (1–5), `complete` (1–5), `contains_personal_data` (boolean) and a short reason. It sees the message and the summary, never the labels. | tech-stack.md lists it as a metric. A different model from the classifier avoids self-grading. About $0.02 per full run. Decided during spec review; using a boolean for personal data, rather than a 1–5 score, is Claude's refinement. |
| Reproducibility | `eval:report` re-scores stored outputs byte-for-byte; a new `eval` run may differ, and the report says so | The model is not deterministic; the scoring is. Decided during spec review. |
| Sets | The full dataset and a fixed small subset. The injection set is not offered in P04. | Decided during spec review. The injection set belongs to P11. |
| Small subset | 18 messages, 3 per intent, covering cs, sk and en, the three channels and at least two designed-ambiguous messages. Chosen once, with a fixed seed, and stored as an ID list. | A fixed file keeps the subset identical over time, even if the selection code changes. It is used while developing (CLAUDE.md, "prefer the small subset") and in CI from P12. |
| CI subset timing | P12, as in the roadmap; tech-stack.md is corrected | Decided during spec review. |
| Repeats | One call per message | Variance is visible by comparing runs; self-consistency is P17. Decided during spec review. |
| Identifier scoring | Micro precision and recall over `(type, value)` pairs, plus exact-list rate | Shows both missed and invented identifiers. Decided during spec review. |
| Confidence | The simple view (correct vs. wrong mean, and four bands) | Gives P07 a basis for its threshold; proper calibration is P17. Decided during spec review. |

### Plan

| Decision | Choice | Why |
| --- | --- | --- |
| Runner | The P00 run guard (`runPaidJobs`): dry run with an estimate, confirmation or `--yes`, `--max-cost` (default $3) and `--concurrency` (default 4) | One paid-run behaviour for every script. Decided during spec review. |
| Keeping runs | `eval/results/*` is git-ignored except `eval/results/kept/` and `eval/results/README.md`; `eval:keep` moves a run there | Paid baselines are kept as evidence for P14's README, without every development run landing in git. Decided during spec review. |
| Report formats | `report.md` and `report.html` (self-contained, inline SVG) | Decided during spec review. The HTML follows the dataviz guidance (form, colour and accessibility) and works in light and dark mode. |
| Code layout | `eval/run.ts` (CLI and runner), `eval/metrics/` (pure scoring functions), `eval/report/` (Markdown and HTML rendering), `eval/judge.ts` (summary judge) | Follows tech-stack.md's layout (`eval/run.ts`). Scoring is pure, so it is unit-tested without files or calls. |
| Interrupted runs | Each output line is appended as soon as its message is done. A run stopped by the budget cap or an error keeps its partial `outputs.jsonl`, and `run.json` marks it `complete: false`. `eval:report` still works on it, and `n` counts only the finished messages. | A paid run is never lost to a crash, and nothing pretends a partial run is complete. |

### Validation

| Decision | Choice | Why |
| --- | --- | --- |
| Paid runs | First the small subset, then (after a second go-ahead) the full baseline. Claude asks before each. | Checks the harness cheaply before the ~$1 run. Decided during spec review. |
| Metric tests | Unit tests on small fixtures with hand-computed expected values; a golden-file test for `report.md`; a reproducibility test (rendering twice gives identical bytes) | The numbers in the baseline are only as good as the scoring code. |

## Notes

- **Cost estimate for a full run:**
  - classifier: about $0.85 (100 × ~3,800 input tokens, mostly cache reads after the first call, plus ~170 output tokens);
  - judge: about $0.02;
  - with the cap at $3, a runaway run stops early.
- **Labels the model can't see.** `final.must_review`, `review_reasons` and `expected_team` aren't produced by the model; they are scored from P07 on, when routing exists.
- **Same text as P03.** The raw (synthetic) text is still sent to the model (P03's masking exception). The baseline is therefore the "before masking" reference for P05.
- **The judge sees personal data too.** The summary judge receives the message, including its synthetic identifiers, to check faithfulness. This falls under the same exception and is revisited in P05.
- **The demo's urgency differences** (msg-006 and msg-059 labelled `normal`, predicted `low`) are the kind of finding the baseline will quantify; P04 does not change the prompt.
- **The prompt files and the build.** `dist/` still doesn't include prompt files (a P03 note for P08); the eval runs with tsx, so this doesn't affect P04.
