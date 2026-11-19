# Phase 9 — Review queue (CLI): Validation

The branch `p09-review-queue-cli` can be merged when every check below passes.

How each check is marked:

- **(test):** automated in Vitest.
  - Unit tests run with `npm test`.
  - Integration tests are under `test/integration/` and run with `npm run test:integration`.
- **(ci):** a step in the GitHub Actions workflow that must be green on the pull request.
- **(manual):** needs a command or human judgement.

## Checks pass

- [x] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build` and `npm run audit` pass. **(ci)**
- [x] `npm test` passes with no `ANTHROPIC_API_KEY` and no network; no test calls a model. **(ci)**
- [x] `npm run test:integration` passes locally and in CI. **(ci)**

## Storage

- [x] Migration `0008` creates `reviews` and `unmask_log` with their checks and indexes; rolling back removes them. **(test)**
- [x] The database rejects a second review of a case, a bad reviewer handle, a `corrected` review without intent, team or note, a `confirmed` review with corrected values, an unknown intent or team, and a too-short unmask reason. **(test)**

## Review rules

- [x] A handle must match `^[a-z0-9][a-z0-9._-]{1,31}$`, the same pattern as the database check. **(test)**
- [x] A correction needs a note and must change the intent, the team or both; picking an intent defaults the team to `INTENT_TO_TEAM`. **(test)**
- [x] `effectiveDecision` gives `pending`, `auto-routed`, `confirmed` (case team and intent) or `corrected` (the review's values), including for a failure case with no classification. **(test)**

## Queue and case view

- [x] The queue holds unreviewed cases with `needs_review` by default and unreviewed cases without it under `--spot-check`; `--team` and `--reason` narrow it; oldest first; the session's skipped cases are left out. **(test)**
- [x] The case view shows the decision, every reason with its detail, the classification and summary, the masked text, the enrichment evidence (found customer and services, ambiguous candidates, unmatched placeholders, area, outages), the decision log and earlier unmaskings. **(test)**
- [x] The case view contains no raw text and no identifier value. **(test)**
- [x] A `processing_failed` case without masked text or classification is shown, with what is missing. **(test)**

## Actions

- [x] Confirm and correct store exactly one review, with the reviewer, the note and `spot_check` copied from the case. **(test)**
- [x] A second review of a case, one after the other or concurrently, stores nothing and reports the existing review's reviewer and time. **(test)**
- [x] Unmask needs a reason, writes the `unmask_log` row before returning the raw text, and the next case view lists it. **(test)**

## The interactive loop

- [x] Scripted input: confirm, correct (new intent with the default team, and a team override), skip, unmask and quit each do what requirements.md says. **(test)**
- [x] A correction without a note, or one that changes nothing, is not stored and the loop asks again. **(test)**
- [x] A case reviewed by someone else while on screen prints "already reviewed by …" and moves on. **(test)**
- [x] No reviewer gives exit code 2 with a usage message; an empty queue says so; end of input ends the session with its summary. **(test)**
- [x] The loop works in a real terminal (`npm run review -- --reviewer <handle>`). **(manual)** Checked by the user.

## Demo

- [x] On a separate demo database, after the user's go-ahead (estimated at $0.06; it cost $0.10), 8 messages processed by the worker; a review session confirms one, corrects one with a new intent, corrects one with a team override, skips one and unmasks one; a `--spot-check` session confirms the auto-routed case. The output and the `reviews` and `unmask_log` rows are in the PR description. **(manual)**

## Specs updated

- [x] [tech-stack.md](../../tech-stack.md) has the final `reviews` and `unmask_log` fields and the review queue's behaviour. **(manual)**
- [x] `README.md` explains `npm run review`, its actions, `REVIEWER`, spot checks and unmasking. **(manual)**
- [x] P09 is marked done in [roadmap.md](../../roadmap.md) after review. **(manual)**

## Scope checks

- [x] No web page (P13); a review never changes a case, re-routes it or writes to the mock CRM. **(manual)**
- [x] The prompts and `summary-judge.v1` are unchanged (registry hashes unchanged). **(test)**
- [x] No model call outside the 8 demo classifications. **(manual)**
