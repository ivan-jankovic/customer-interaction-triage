# Phase 4 — Evaluation harness and baseline: Validation

The branch `p04-eval-harness-baseline` can be merged when every check below passes.

How each check is marked:

- **(test):** automated in Vitest (`npm test`).
- **(ci):** a step in the GitHub Actions workflow that must be green on the pull request.
- **(manual):** needs a command or human judgement.

## Checks pass

- [ ] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build` and `npm run audit` pass. **(ci)**
- [ ] `npm test` passes with no `ANTHROPIC_API_KEY` and no network; no test calls a model. **(ci)**
- [ ] `npm run test:integration` passes (nothing in it changes in P04). **(ci)**

## Subset

- [ ] `eval/data/subsets/small.json` has 18 unique dataset IDs: 3 per intent, with cs, sk and en, all three channels, and at least two designed-ambiguous messages. Running the selection again gives the same list. **(test)**

## Metrics

- [ ] On the fixture, every metric in requirements.md (Metrics) equals its hand-computed value: intent accuracy (invalid and error count as wrong), per-intent precision and recall, macro F1, the confusion matrix with the `invalid / error` column, urgency, language, service type and area accuracy (area ignoring case and diacritics), identifier micro precision and recall, exact-list rate, the summary means, the personal-data share, the confidence bands, cost and latency percentiles. **(test)**
- [ ] Per-language metrics are computed for cs, sk and en, and a language with fewer than 30 messages is marked indicative only. **(test)**
- [ ] The worst-errors list holds the wrong intents sorted by confidence, highest first. **(test)**

## Judge

- [ ] The judge gets the message and the summary but no labels, uses `claude-haiku-5-5` at effort `low` without fallbacks, and validates its output; out-of-range scores, invalid JSON and refusals become "not graded". **(test)**
- [ ] No judge call is made for an invalid or failed classification. **(test)**
- [ ] `summary-judge.v1` is in the prompt version registry. **(test)**

## Runner and reports

- [ ] `npm run eval -- --dry-run` prints the plan and the estimated cost, makes no call and writes no files. **(test)**
- [ ] A run with a mocked client writes `run.json`, `outputs.jsonl` (one line per message, in ID order, without message text), `metrics.json`, `report.md` and `report.html`. **(test)**
- [ ] When the budget cap is reached, the run stops starting new messages, keeps the finished lines, and `run.json` says `complete: false`. **(test)**
- [ ] `run.json` records the model, effort, prompt and judge versions with their hashes, the dataset hash and the git commit. **(test)**
- [ ] `report.md` matches the golden file for the fixture. **(test)**
- [ ] `eval:report` on an existing run reproduces `metrics.json`, `report.md` and `report.html` byte-for-byte. **(test)**, and **(manual)** on the real subset run
- [ ] `eval:report` warns when the dataset hash differs from the run's. **(test)**
- [ ] `report.html` loads nothing external: no `<script src`, no `<link`, no `http(s)://` resource. **(test)**
- [ ] `report.html` is readable in light and dark mode and on a phone-width window. **(manual)**
- [ ] Without `ANTHROPIC_API_KEY`, `npm run eval` (not a dry run) fails with a clear message before any call. **(test)**

## Paid runs

- [ ] After the user's go-ahead, `npm run eval -- --subset small --yes` completes, and its report is checked. **(manual)**
- [ ] After a second go-ahead, the full run completes with `n = 100`. Its run folder is moved to `eval/results/kept/` and committed as the baseline. **(manual)**
- [ ] The baseline's intent accuracy, macro F1, per-language accuracy, valid rate, summary means, total cost and latency p50/p95 are quoted in the PR description. **(manual)**

## Specs updated

- [ ] [tech-stack.md](../../tech-stack.md) says the CI evaluation subset comes in P12, and describes the run layout, the subset and the summary judge. **(manual)**
- [ ] `eval/results/README.md`, `README.md` and `.env.example` describe how to run, reproduce and keep an evaluation. **(manual)**
- [ ] P04 is marked done in [roadmap.md](../../roadmap.md) after review. **(manual)**

## Scope checks

- [ ] There is no CI evaluation job and no API-key secret (P12). **(manual)**
- [ ] There are no routing or must-review metrics (P07), and nothing writes to the database. **(manual)**
- [ ] `classify.v1` is unchanged: its hash in the registry is the P03 one. **(test)**
