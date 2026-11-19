# Phase 12 — Evaluation in CI and comparisons: Validation

The branch `p12-eval-in-ci-comparisons` can be merged when every check below passes.

How each check is marked:

- **(test):** automated in Vitest, run with `npm test`.
- **(ci):** a step in a GitHub Actions workflow that must be green (or, where stated, red) on the pull request.
- **(manual):** needs a command or human judgement.

## Checks pass

- [ ] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build` and `npm run audit` pass. **(ci)**
- [ ] `npm test` passes with no `ANTHROPIC_API_KEY` and no network; no unit test calls a model. **(ci)**
- [ ] `npm run test:integration` passes in CI (nothing in this phase touches the database or Redis). **(ci)**

## The threshold check

- [ ] `eval:check` passes a small run with 18/18 and 16/18 right intents and full must-review recall. **(test)**
- [ ] It fails a run with 15/18 right intents, a run with one missed must-review message, an incomplete run and a `full` run, and exits 1 for each. **(test)**
- [ ] `--min-intent-correct` raises the bar; the thresholds are message counts in `eval/ci-threshold.ts`. **(test)**
- [ ] It passes on the stored small `classify.v2` run's metrics. **(test)**

## CI

- [ ] `.github/workflows/eval.yml` has one job `eval`, runs on PRs and pushes to `main` only for the paths in requirements.md (CI) and on `workflow_dispatch`, pins actions to SHAs and has `permissions: contents: read`. **(manual)**
- [ ] `ci.yml` is unchanged and still calls no model. **(manual)**
- [ ] Without the secret the job ends green with a notice and makes no model call. **(manual)** (seen on a Dependabot PR or by reading the step's condition)
- [ ] On the PR, `eval` runs the small subset with the summary judge, is green, and the job summary shows the `eval:check` verdict and the report; the run folder is an artifact. **(ci)**
- [ ] A `workflow_dispatch` run with `min_intent_correct=19` fails at `eval:check`; both runs are linked in the PR description. **(ci)**
- [ ] The CI secret is a separate key with its own spend limit, set by the user. **(manual)**

## Comparison

- [ ] `eval:compare` shows routing (routing accuracy, must-review recall and precision, review rate) and per-intent F1 for both runs, with "–" for a run without routing. **(test)**
- [ ] After the user's go-ahead (~$0.35), a full `classify.v2` run on `claude-sonnet-5-5` is kept, and `eval/results/kept/comparisons/p12-opus-vs-sonnet.md` compares it with the kept Opus run on the same dataset hash. **(manual)**
- [ ] The headline numbers (intent accuracy, must-review recall, routing accuracy, cost per message, latency) and any missed must-review message are recorded in requirements.md (Results) and the README. **(manual)**

## Specs updated

- [ ] [tech-stack.md](../../tech-stack.md) describes the `eval` workflow, its triggers, the secret and the threshold, and the Opus vs Sonnet comparison. **(manual)**
- [ ] `README.md`, `eval/results/README.md` and `CLAUDE.md` (merge rule) are updated. **(manual)**
- [ ] P12 is marked done in [roadmap.md](../../roadmap.md) after review. **(manual)**

## Scope checks

- [ ] `classify.v2`, `investigate.v1` and `summary-judge.v1` are unchanged (registry hashes unchanged). **(test)**
- [ ] The default model is still `claude-opus-5-5` (`src/config.ts`). **(test)**
- [ ] The dataset, the small subset and the injection set are unchanged (file hashes). **(test)**
- [ ] No injection run in CI, no web page (P13). **(manual)**
- [ ] No model call outside the Sonnet run and the CI runs. **(manual)**
