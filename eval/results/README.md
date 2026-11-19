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
