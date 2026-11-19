# Evaluation runs

`npm run eval` writes one folder per run here (see the [P04 spec](../../specs/phases/005-p04-eval-harness-baseline/requirements.md)). Runs are ignored by git, except the ones moved to [`kept/`](kept/) with `npm run eval:keep -- <run-id>`.

## A run folder

`<run-id>` is `YYYYMMDD-HHMMSS-<set>-<model>-<prompt-version>` (UTC), for example `20261119-143000-full-claude-opus-5-5-classify.v1`.

| File | Content |
| --- | --- |
| `run.json` | Set and message IDs, classifier and judge (model, effort, prompt version and SHA-256), masker version (from P05; runs before it sent raw text), dataset file and SHA-256, git commit (and whether the tree had uncommitted changes), start and end time, whether the run is complete, and the cost guard's totals |
| `outputs.jsonl` | One line per message, in ID order: the classification attempt (raw model output, outcome, classification, errors, requested and serving model, usage, cost, latency) and the summary judge's result. No message text. |
| `metrics.json` | Every metric, computed from `outputs.jsonl` and the dataset's final labels; routing metrics (from P07) also from the mock CRM seed (`eval/data/crm/seed.json`), whose hash is recorded |
| `report.md` | The metrics as Markdown tables |
| `report.html` | The same report as one self-contained page (no external resources; light and dark mode) |

## Reproducing a report

`npm run eval:report -- <run-id>` recomputes `metrics.json`, `report.md` and `report.html` from `run.json`, `outputs.jsonl`, the dataset and the CRM seed, with no model calls, and gives the same bytes. Routing is recomputed with the current rules (`route.v2` since P08), so recomputing an older run adds or updates its routing section. It warns if the dataset changed since the run, because the labels it scores against may have changed.

A new `npm run eval` calls the model again; its numbers can differ slightly from an earlier run's.

## Incomplete runs

A run stopped by the cost cap keeps the messages it finished. `run.json` says `"complete": false`, and the report says how many messages finished.

## Investigation runs (P10)

`npm run eval:investigate` writes the same kind of folder, named `<time>-investigate-<set>-<model>-investigate.v1`, with `"kind": "investigate"` in `run.json`. Its `run.json` also names the classify run whose stored classifications were the input, and the CRM seed (the labels are the seed's designed causes). Each line of `outputs.jsonl` is one labelled technical fault: the agent's attempt (cause, evidence, every tool call with its result, usage, cost), or why it wasn't investigated. `npm run eval:report` recognises the kind and recomputes the investigation report.

`npm run eval:injection` (P11) writes a folder named `<time>-injection-x<repeats>-<model>-classify.v2`, with `"kind": "injection"` in `run.json`, which also records the router version, the CRM seed and the injection set's hash. Each line of `outputs.jsonl` is one repeat of one injection message: the classification attempt, the agent's attempt for a valid technical fault (or null) and the judge's grade. Routing and the pass rule are recomputed from these lines, so `npm run eval:report` rescores the run with the current router and seed.

## Comparisons

`npm run eval:compare -- <run A> <run B> [--out file.md]` puts two runs side by side from their `run.json` and `metrics.json` (free): settings, headline metrics with the change from A to B, routing and must-review (from P12), per-intent F1 and per-language intent and urgency. It warns when the runs cover different messages or dataset files. Kept comparisons are in [`kept/comparisons/`](kept/comparisons/): `classify.v1` vs `classify.v2` (P05) and `claude-opus-5-5` vs `claude-sonnet-5-5` (P12).

## The CI threshold (P12)

`npm run eval:check -- <run-id> [--min-intent-correct n] [--summary file]` checks a small-subset run against the CI threshold in [`eval/ci-threshold.ts`](../ci-threshold.ts): at least 16 of 18 intents right, no message labelled must-review auto-routed, and a complete small run. It prints the verdict as a Markdown table, appends it to `--summary` when given, and exits 1 when any check fails. CI runs are not committed; their folders are attached to the `eval` job as artifacts.
