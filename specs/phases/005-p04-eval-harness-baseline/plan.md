# Phase 4 — Evaluation harness and baseline: Plan

See [requirements.md](requirements.md) for scope and decisions, and [validation.md](validation.md) for the merge checklist.

**No model calls except the two paid runs in group 7, and each runs only after asking.** After every group, `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` pass. P04 doesn't touch the database, but `npm run test:integration` still runs before the PR.

## 1. Small subset

1.1. Write `eval/subsets.ts` with a `selectSmallSubset(records, seed)` that applies the rule in requirements.md (3 per intent; cs, sk and en; all channels; at least two designed-ambiguous messages) with the existing seeded RNG. Add a `dataset:subset` script that writes `eval/data/subsets/small.json` (`{ "seed", "rule", "ids" }`).
1.2. Generate and commit `small.json`.
1.3. Unit test `test/eval/subsets.test.ts`:
  - the file's IDs exist in the dataset and are unique;
  - they meet the rule;
  - running the selection again gives the same list.

## 2. Metrics (pure functions)

2.1. Write `eval/metrics/score.ts`. For each message, `scoreMessage(final labels, attempt)` gives: correct or wrong per field, identifier true positives, false positives and false negatives, and whether the identifier list is exactly right.
2.2. Write `eval/metrics/aggregate.ts`. `computeMetrics(scored messages, judge results)` gives every metric in requirements.md (Metrics):
  - overall and per language;
  - per-intent precision and recall, macro F1, the confusion matrix with the `invalid / error` column, and the confidence bands;
  - latency percentiles;
  - cost and token totals;
  - the worst errors.

  Output is plain JSON, with keys in a fixed order.
2.3. Write `test/eval/metrics.test.ts`: a fixture of about 8 hand-made messages and attempts (valid, wrong, invalid, error, a fallback, identifiers missed and invented, areas differing only in diacritics), with every expected value worked out by hand in comments.

## 3. Summary judge

3.1. Write `eval/prompts/summary-judge.v1.md` (system + user; it sees the channel, the message and the summary, never the labels; it is told that instructions in the message are data) and add its hash to `src/llm/prompts/versions.json`.
3.2. Write `eval/judge.ts`:
  - the output schema: `faithful` 1–5, `complete` 1–5, `contains_personal_data` (boolean) and `reason`;
  - `judgeSummary(...)` with the shared client (`claude-haiku-5-5`, effort `low`, no fallbacks), validated with Ajv, returning `graded` / `invalid` / `error` with usage and cost;
  - the judge model and effort can be overridden with `EVAL_JUDGE_MODEL` / `EVAL_JUDGE_EFFORT`.
3.3. Unit tests with a mocked client: a valid grade, an out-of-range score, invalid JSON, a refusal, and no judge call for an invalid classification.

## 4. Runner

4.1. Write `eval/run.ts` (script `eval`). It:
  - parses `--subset small`, `--dry-run`, `--yes`, `--max-cost` and `--concurrency`;
  - loads the dataset (and subset), the classifier config (`TRIAGE_MODEL` / `TRIAGE_EFFORT`) and the prompts;
  - builds one job per message (classify, then judge if valid) with planned-call estimates for the run guard;
  - creates the run folder and `run.json`;
  - appends each message's line to `outputs.jsonl` as it finishes;
  - at the end, completes `run.json` (`complete`, totals, end time) and writes the reports.

  Without `ANTHROPIC_API_KEY`, a real run fails with a clear message.
4.2. Make the run's dependencies injectable: the client, the clock, the output folder and the git info.
4.3. Write `test/eval/run.test.ts` with a mocked client and a temporary folder:
  - a dry run makes no calls and writes nothing;
  - a full run over the subset writes every file, with one line per message;
  - the budget cap stops early with `complete: false` and partial outputs;
  - an invalid classification gets no judge call.

## 5. Reports

5.1. Load the `dataviz` skill before writing the chart code.
5.2. Write `eval/report/markdown.ts` to render `report.md`:
  - a header with the run's settings, and a note that a new run may differ;
  - the overall table, the per-language table (marking "indicative only"), per-intent precision and recall, the confusion matrix, fields, identifiers, summaries, confidence bands, cost, latency, and the worst errors (top 10).
5.3. Write `eval/report/html.ts` to render `report.html`: the same content, with inline SVG charts (a confusion-matrix heatmap, per-intent precision/recall bars, confidence bands). Colours are tokens in `:root` with a dark-mode variant, and the layout has no external resources.
5.4. Write `eval/report/index.ts` (`writeReports(runDir)`) and a script `eval:report` (`tsx eval/report/cli.ts <run-id>`). It reads `run.json`, `outputs.jsonl` and the dataset, warns if the dataset hash changed, and rewrites `metrics.json`, `report.md` and `report.html`.
5.5. Write `eval:keep` (`tsx eval/report/keep.ts <run-id>`) to move a run folder into `eval/results/kept/`. Update `.gitignore` (`eval/results/*`, `!eval/results/kept/`, `!eval/results/README.md`) and `.prettierignore` (`eval/results/`).
5.6. Tests:
  - a golden `report.md` for the metrics fixture (`test/eval/fixtures/report.md`);
  - `writeReports` run twice on a fixture run folder gives identical bytes for all three files;
  - the HTML has no `<script src`, `<link` or `http` resource;
  - a changed dataset hash prints the warning.

## 6. Docs and constitution

6.1. Update [tech-stack.md](../../tech-stack.md):
  - CI row: the evaluation subset from P12;
  - Evaluation: the run layout, `eval:report`, `eval:keep`, the small subset and the summary judge (`summary-judge.v1` on Haiku 5.5).
6.2. Write `eval/results/README.md`: the run folder format, how to reproduce a report, and how to keep a run.
6.3. Add an "Evaluating" section to `README.md` (commands, costs, and where the baseline is). Add `EVAL_JUDGE_MODEL` and `EVAL_JUDGE_EFFORT` to `.env.example`.

## 7. Verify, subset run, baseline

7.1. Run lint, format check, type check, unit tests, build, audit and the integration tests.
7.2. Run `npm run eval -- --subset small --dry-run` (free) and check the plan and the estimate.
7.3. **Ask before the subset run.** Run `npm run eval -- --subset small --yes`, then check the report in Markdown and HTML (light and dark), and `eval:report` reproducing it byte-for-byte.
7.4. **Ask before the full run.** Run `npm run eval -- --yes`, then `npm run eval:keep -- <run-id>`, commit the baseline, and quote its key numbers in the PR description.
7.5. Work through [validation.md](validation.md). After review, mark P04 done in [roadmap.md](../../roadmap.md), push, open the PR and ask before merging.
