# Phase 12 — Evaluation in CI and comparisons: Validation

The branch `p12-eval-in-ci-comparisons` can be merged when every check below passes.

How each check is marked:

- **(test):** automated in Vitest, run with `npm test`.
- **(ci):** a step in a GitHub Actions workflow that must be green (or, where stated, red) on the pull request.
- **(manual):** needs a command or human judgement.

## Checks pass

- [x] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build` and `npm run audit` pass. **(ci)**
- [x] `npm test` passes with no `ANTHROPIC_API_KEY` and no network; no unit test calls a model. **(ci)**
- [x] `npm run test:integration` passes in CI (nothing in this phase touches the database or Redis). **(ci)**

## The threshold check

- [x] `eval:check` passes a small run with 18/18 and 16/18 right intents and full must-review recall. **(test)**
- [x] It fails a run with 15/18 right intents, a run with one missed must-review message, an incomplete run and a `full` run, and exits 1 for each. **(test)**
- [x] `--min-intent-correct` raises the bar; the thresholds are message counts in `eval/ci-threshold.ts`. **(test)**
- [x] It passes on the kept full `classify.v2` outputs for the 18 small-subset messages (see requirements.md, Implementation notes). **(test)**

## CI

- [x] `.github/workflows/eval.yml` has one job `eval`, runs on PRs and pushes to `main` only for the paths in requirements.md (CI) and on `workflow_dispatch`, pins actions to SHAs and has `permissions: contents: read`. **(manual)**
- [x] `ci.yml` is unchanged and still calls no model. **(manual)**
- [x] Without the secret the job ends green with a notice and makes no model call. **(manual)** (seen on a Dependabot PR or by reading the step's condition) Checked by reading: every step after the key check runs only when that check found the secret (`secrets.ANTHROPIC_API_KEY != ''`); no Dependabot PR has hit it yet.
- [x] On the PR, `eval` runs the small subset with the summary judge, is green, and the job summary shows the `eval:check` verdict and the report; the run folder is an artifact. **(ci)** [Run 44638499736](https://github.com/ivan-jankovic/customer-interaction-triage/actions/runs/44638499736): 18/18 intents, 6/6 must-review, $0.17.
- [x] A `workflow_dispatch` run with `min_intent_correct=19` fails at `eval:check`; both runs are linked in the PR description. **(ci)** [Run 44638854433](https://github.com/ivan-jankovic/customer-interaction-triage/actions/runs/44638854433): "18 of 18 intents right; at least 19 required", exit 1, $0.11.
- [x] The CI secret is a separate key with its own spend limit, set by the user. **(manual)** The secret is set (2026-11-19); the user confirmed it is a separate key with its own spend limit.

## Comparison

- [x] `eval:compare` shows routing (routing accuracy, must-review recall and precision, review rate) and per-intent F1 for both runs, with "–" for a run without routing. **(test)**
- [x] After the user's go-ahead (~$0.35), a full `classify.v2` run on `claude-sonnet-5-5` is kept, and `eval/results/kept/comparisons/p12-opus-vs-sonnet.md` compares it with the kept Opus run on the same dataset hash. **(manual)**
- [x] The headline numbers (intent accuracy, must-review recall, routing accuracy, cost per message, latency) and any missed must-review message are recorded in requirements.md (Results) and the README. **(manual)**

## Specs updated

- [x] [tech-stack.md](../../tech-stack.md) describes the `eval` workflow, its triggers, the secret and the threshold, and the Opus vs Sonnet comparison. **(manual)**
- [x] `README.md`, `eval/results/README.md` and `CLAUDE.md` (merge rule) are updated. **(manual)**
- [x] P12 is marked done in [roadmap.md](../../roadmap.md) after review. **(manual)**

## Scope checks

- [x] `classify.v2`, `investigate.v1` and `summary-judge.v1` are unchanged (registry hashes unchanged). **(test)**
- [x] The default model is still `claude-opus-5-5` (`src/config.ts`). **(test)**
- [x] The dataset, the small subset and the injection set are unchanged (file hashes). **(test)**
- [x] No injection run in CI, no web page (P13). **(manual)**
- [x] No model call outside the Sonnet run and the CI runs. **(manual)**
