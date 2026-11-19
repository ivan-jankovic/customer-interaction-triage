# Phase 12 — Evaluation in CI and comparisons: Requirements

## Context

This is phase P12 in [roadmap.md](../../roadmap.md). Since P04, `npm run eval` classifies the dataset (or the 18-message small subset, `--subset small`) under the paid-run guard and writes a run folder with metrics, including routing accuracy and must-review recall (from P07). Since P05, `npm run eval:compare` puts two runs side by side. CI (`.github/workflows/ci.yml`) runs `checks` and `integration`, and no job calls a model.

So far the evaluation only runs when someone remembers to run it. This phase makes it part of CI, so a change that hurts the classifier turns a pull request red, and it answers a cost question with numbers: is a cheaper model good enough? It serves two lines of [mission.md](../../mission.md):

- **Success criterion:** "a small evaluation subset runs in CI with a model."
- **Principle "Measured, not assumed":** a model choice is shown by evaluation results, not by assumption.

## Scope

In scope:

- **`npm run eval:check -- <run-id>`:** reads a run's `metrics.json` and exits non-zero when it is below the threshold (see The threshold). Pure, free, no model call.
- **A new workflow `.github/workflows/eval.yml`** with one job, `eval`: runs `npm run eval -- --subset small --yes`, then `eval:check`, and publishes the result (see CI).
- **The model comparison:** a full `classify.v2` run on `claude-sonnet-5-5`, compared with the kept `claude-opus-5-5` run (see Comparison).
- **`eval:compare` extended** with routing (routing accuracy, must-review recall and precision, review rate) and per-intent F1, so the comparison shows what matters for review.
- **Docs:** [tech-stack.md](../../tech-stack.md) (CI row, Evaluation), `README.md` ("Evaluating": CI and the comparison), `eval/results/README.md`, and `CLAUDE.md` (the merge rule also needs `eval` green when it ran). Approving this spec approves these edits.

Out of scope (later phases):

- The injection set in CI or in the comparison (decided during spec review; see Decisions).
- A comparison of prompt versions (`classify.v1` vs `classify.v2` was compared in P05).
- Changing the default model. The comparison reports; switching `TRIAGE_MODEL` would be a separate, agreed decision.
- The review web page (P13) and the full results write-up in the README (P14).

## The threshold

Decided during spec review: **intent accuracy and must-review recall.**

The small run fails the check when either is true:

| Check | Fails when | Why |
| --- | --- | --- |
| Intent accuracy | fewer than **16 of 18** messages have the right intent (below 88.9%) | Leaves room for one or two wobbles of a non-deterministic model; three misses on 18 (one in six) is a real drop. Invalid outputs and errors count as wrong, as in every accuracy. |
| Must-review recall | below **100%** | A message labelled must-review that is auto-routed is the failure the mission cares most about; no margin. |

- The thresholds live in code (`eval/ci-threshold.ts`), as numbers of messages, not percentages, so a subset change can't silently loosen them.
- Everything else (urgency, fields, judge scores, cost) is reported in the CI summary but doesn't decide pass or fail. The judge is **advisory**, as in P11.
- `eval:check` also fails when the run is incomplete (stopped by the cost cap) or is not the small subset, so a partial run can't pass.

## CI

Decided during spec review: **a separate workflow, run when the model's input or scoring changes.**

- **`.github/workflows/eval.yml`**, job `eval`, so `ci.yml` stays model-free as its header comment says.
- **Triggers:**
  - pull requests and pushes to `main` that change `src/llm/**`, `src/pipeline/**`, `src/taxonomy.ts`, `src/config.ts`, `eval/**`, `package.json`, `package-lock.json` or `.github/workflows/eval.yml`;
  - `workflow_dispatch` (the "Run workflow" button), with an optional input `min_intent_correct` that overrides the intent threshold. It exists to show a red run on purpose (see Validation); pull requests and pushes always use the code's threshold.
- **Secret:** `ANTHROPIC_API_KEY`. When it is not available (Dependabot or a fork's pull request), the job writes a notice and ends green without a model call. Skipped is not failed: such a PR is not evaluated, and the summary says so.
- **Cost guard:** `--yes --max-cost 1` (a small run costs about $0.12).
- **Output:** the run's `report.md` and the `eval:check` verdict go to the job summary (`$GITHUB_STEP_SUMMARY`); the whole run folder is uploaded as an artifact (kept 30 days). Nothing is committed from CI.
- **Concurrency:** one eval per branch; a new push cancels the running one, so quick pushes don't pay twice.
- **The key:** decided during spec review, a **separate CI key** in its own Console workspace with a low monthly spend limit (about $10), so it can be revoked alone and a runaway loop costs little. The user creates it and adds it with `gh secret set ANTHROPIC_API_KEY`; Claude never handles the key.
- Actions pinned to commit SHAs, as in `ci.yml`; `permissions: contents: read`.

## Comparison

Decided during spec review: **`claude-opus-5-5` vs `claude-sonnet-5-5`, on the full dataset only.**

- **A:** the kept run `eval/results/kept/20261119-010458-full-claude-opus-5-5-classify.v2/` (reused; no new Opus cost).
- **B:** a new full run, `TRIAGE_MODEL=claude-sonnet-5-5 npm run eval`, same prompt (`classify.v2`), effort `low`, masker, judge (`summary-judge.v1` on `claude-haiku-5-5`, still a different model from the classifier) and dataset. About **$0.35**, after asking. The run is kept.
- **Output:** `npm run eval:compare` writes `eval/results/kept/comparisons/p12-opus-vs-sonnet.md`. The headline numbers go into this file (Results) and the README.
- The table reads: intent accuracy and macro F1, per-intent F1, urgency and field accuracy, routing accuracy, must-review recall and precision, review rate, summary scores, confidence, cost per message, latency p50 and p95, and intent per language.
- **What it decides:** nothing by itself. The result says whether Sonnet is good enough for the routine path (same must-review recall, intent accuracy within a message or two) and at what saving. Switching the default is a later decision.

## Decisions

### Requirements

| Decision | Choice | Why |
| --- | --- | --- |
| What to compare | `claude-opus-5-5` vs `claude-sonnet-5-5` with `classify.v2` | Prompt versions were compared in P05; the cost question is the new information, and the kept Opus run is reused. Decided during spec review. |
| Threshold | Intent ≥ 16/18 and must-review recall 100% | Tolerates normal variation, never tolerates a missed review. Decided during spec review. |
| When CI evaluates | PRs and pushes to `main` touching model input or scoring, plus manual runs; skipped without the secret | Pays only when the result could change. Decided during spec review. |
| Injection set | Not in CI, not in the comparison | Its safety comes from code checks (P11); a model comparison there adds cost for little information. Decided during spec review. |

### Plan

| Decision | Choice | Why |
| --- | --- | --- |
| Where the job lives | Separate `eval.yml`, job `eval` | Native path filters and `workflow_dispatch`; `ci.yml` stays model-free. Decided during spec review. |
| Judge in CI | Yes, advisory | The same command as a local small run, so CI runs compare with kept runs. Decided during spec review. |
| Threshold check | A separate `eval:check` command over `metrics.json` | Free and testable without a model; works on any stored run, including kept ones. |

### Validation

| Decision | Choice | Why |
| --- | --- | --- |
| Proving the red path | Unit tests of `eval:check`, plus one real CI run made red on purpose (`workflow_dispatch` with `min_intent_correct=19`), linked in the PR | Shows the job really fails, not only the function. Decided during spec review. |
| CI key | Separate key, own workspace, low spend limit | A leak or a loop costs little and is revoked alone. Decided during spec review. |
| Paid runs | The Sonnet full run (~$0.35) after asking; CI runs on the PR (~$0.12 each) once the secret is set | Model calls cost money (CLAUDE.md). |

## Notes

- **CI spending during this phase:** every push to the PR that touches the filtered paths pays about $0.12. Most of this phase's commits touch `eval/**`, so expect several runs (well under $2). The workflow is added in a late task group to keep this low.
- **`CLAUDE.md`** says to merge when `checks` and `integration` are green; it gains "and `eval` when it ran".
- **Pricing:** `src/llm/pricing.ts` already has `claude-sonnet-5-5` ($2 / $10 per million tokens), so `TRIAGE_MODEL` accepts it without a code change.
- **No new dependencies** are expected.
