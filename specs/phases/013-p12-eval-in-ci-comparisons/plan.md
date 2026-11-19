# Phase 12 — Evaluation in CI and comparisons: Plan

See [requirements.md](requirements.md) for scope and decisions, and [validation.md](validation.md) for the merge checklist.

**The only model calls are the Sonnet full run in group 3 (~$0.35, after asking) and the CI runs from group 4 on (~$0.12 each, once the user has set the secret).** After every group, `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` pass. No group touches the database or Redis.

## 1. The threshold check

1.1. `eval/ci-threshold.ts`: the thresholds as message counts (`MIN_INTENT_CORRECT = 16`, `MIN_MUST_REVIEW_RECALL = 1`) and a pure `checkRun(info, metrics, overrides?)` that returns each check (intent, must-review recall, complete, set is `small`) with pass/fail and why.

1.2. `eval/check.ts` and the `eval:check` script: `npm run eval:check -- <run-id> [--min-intent-correct n] [--summary file]`. Prints the verdict as a Markdown table, appends it to `--summary` when given (for `$GITHUB_STEP_SUMMARY`), exits 1 on failure. Resolves run IDs like `eval:report` (`resolveRunDir`).

1.3. Unit tests (`test/eval/ci-threshold.test.ts`): 18/18 and 16/18 pass; 15/18 fails; one missed must-review fails; an incomplete run fails; a `full` run fails; the override raises the bar; the CLI exits 0 and 1; the kept small `classify.v2` metrics fixture passes.

## 2. `eval:compare` extended

2.1. `eval/compare.ts`: a "Routing" table (routing accuracy, must-review recall and precision, review rate) and a "Per intent" table (F1 for A and B with the change). Older runs without routing metrics show "–".

2.2. Unit tests (`test/eval/compare.test.ts`): the new tables from two fixture runs; a run without routing shows "–"; the existing output for the P05 comparison is unchanged apart from the added sections.

## 3. The model comparison

3.1. `TRIAGE_MODEL=claude-sonnet-5-5 npm run eval -- --dry-run`; check the plan and estimate.

3.2. **After asking** (~$0.35): `TRIAGE_MODEL=claude-sonnet-5-5 npm run eval`; `npm run eval:keep` the run.

3.3. `npm run eval:compare -- <kept Opus classify.v2> <Sonnet run> --out eval/results/kept/comparisons/p12-opus-vs-sonnet.md`; record the headline numbers in requirements.md (Results). If Sonnet misses a must-review message, list it there.

## 4. The CI workflow

4.1. `.github/workflows/eval.yml`: job `eval` with the triggers, path filters, concurrency, `permissions: contents: read` and pinned actions from requirements.md (CI). Steps: checkout, setup-node, `npm ci`; a step that ends green with a notice when `ANTHROPIC_API_KEY` is empty; `npm run eval -- --subset small --yes --max-cost 1`; `npm run eval:check -- <run> --summary "$GITHUB_STEP_SUMMARY"` (with `--min-intent-correct` only from the `workflow_dispatch` input); the run's `report.md` appended to the summary; the run folder uploaded as an artifact (30 days), also on failure.

4.2. The eval run prints its run ID in a form the workflow can read (e.g. `run-id=<id>` to `$GITHUB_OUTPUT` when set), so the later steps don't guess the folder. A unit test covers it.

4.3. The user creates the separate CI key and runs `gh secret set ANTHROPIC_API_KEY`. Claude asks for this and waits; it never handles the key.

## 5. Docs

5.1. [tech-stack.md](../../tech-stack.md): the CI row (`eval.yml`, triggers, secret, threshold) and Evaluation ("Runs": the small subset in CI with `eval:check`; "Comparisons": Opus vs Sonnet).

5.2. `README.md` "Evaluating": `eval:check`, the CI job and what makes it run, the comparison table. `eval/results/README.md`: comparisons folder and `eval:check`. `CLAUDE.md`: merge when `checks`, `integration` and (when it ran) `eval` are green.

## 6. Verify and demo

6.1. Run lint, format check, type check, unit tests, build and audit.

6.2. Push and open the PR. The `eval` job runs on it and is green; its summary shows the verdict and the report.

6.3. **The red run:** `gh workflow run eval.yml --ref p12-eval-in-ci-comparisons -f min_intent_correct=19`; the job fails at `eval:check`. Link both runs in the PR description.

6.4. Work through [validation.md](validation.md). After review, mark P12 done in [roadmap.md](../../roadmap.md), and ask before merging.
