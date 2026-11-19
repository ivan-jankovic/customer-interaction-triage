# Phase 7 — Routing rules and decision log: Plan

See [requirements.md](requirements.md) for scope and decisions, and [validation.md](validation.md) for the merge checklist.

**The only model calls are classifying the six demo messages in group 7, and only after asking.** After every group, `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` pass. `npm run test:integration` must also pass after groups that touch the database.

## 1. Routing rules (pure)

1.1. Add `REASON_CODES` and the type `ReasonCode` to `src/taxonomy.ts`, in the order of requirements.md (Review reasons). Also add `investigation_inconclusive`, marked as produced from P10.

1.2. Write `src/pipeline/route.ts`:
  - the constants `ROUTER_VERSION = "route.v1"`, `REVIEW_CONFIDENCE_THRESHOLD = 0.7` and `UNIDENTIFIED_REVIEW_INTENTS = ["technical_fault"]`;
  - the function `route(input)`. Its input is `{ attempt outcome, classification | null, enrichment | null, customerServiceTypes }`. Its result is `{ targetTeam, needsReview, reasonCodes, firedRules: [{ reasonCode, detail }] }`.

  Details name placeholders and IDs only.

1.3. Unit tests (`test/pipeline/route.test.ts`), one or more per rule:
  - team by intent for all six intents;
  - `general` + `invalid_output` and `general` + `classification_error`;
  - `cancellation`, `complaint`;
  - confidence 0.69 is reviewed, 0.7 is not;
  - `customer_not_found`, `customer_ambiguous`;
  - `customer_unidentified` for `technical_fault`, and not for any other intent (`billing_question` and `tariff_change` without identifiers are routed with no review);
  - `crm_mismatch_unmatched_key`;
  - `crm_mismatch_service_type`: fires when the customer lacks the type; does not fire when the customer has it terminated, or when the type is `unknown`;
  - several reasons at once, kept in table order;
  - no reasons → `needsReview` false;
  - no detail contains an identifier value from the fixture.

## 2. Dataset-wide check on kept outputs

2.1. Write a small shared helper, `eval/lib/route-message.ts`, used by both this test and the eval scoring. It runs mask → enrich (in-memory CRM from `seed.json`, with the seed's `received_at`) → route for one dataset message and one classification attempt.

2.2. Write `test/pipeline/route-dataset.test.ts`. It routes the 100 outputs of `eval/results/kept/20261119-010458-full-claude-opus-5-5-classify.v2/` and asserts:
  - every message labelled `must_review` is sent to review, with the missed IDs in the failure message;
  - every team equals `expected_team`;
  - every `unclear` message has `low_confidence`.

  It also prints the review rate and the count for each code, for the PR.

## 3. Storage and the routing step

3.1. Migration `src/db/migrations/0006_cases.ts` with `cases` and `decision_log`, following requirements.md (Data):
  - checks on `target_team`, `step`, and `needs_review` versus `reason_codes`;
  - `enrichment_id` null exactly when the classification isn't valid; this needs the outcome, so the check is done in code and tested;
  - a unique `interaction_id`, and a unique `(case_id, step)` and `(case_id, seq)`;
  - foreign keys and an index on `needs_review`.

  Add the types to `src/db/database.ts`.

3.2. Write `src/db/cases.ts`.
  - `routeInteraction(db, interactionId)` does the following:
    1. If a case exists, returns it with `created: false`.
    2. Otherwise picks the classification and enrichment following requirements.md (Which inputs are used), and fails clearly with `NotReadyForRouting` ("classify first" / "enrich first").
    3. Reads the customer's service types through `KyselyCrm`.
    4. Calls `route`.
    5. Inserts the case and its decision-log entries in one transaction. On a unique conflict, it rolls back and returns the existing case.
  - `readCase(db, interactionId)` returns the case with its log.

3.3. Integration tests (`test/integration/cases.int.test.ts`):
  - migration round trip with `0006`;
  - one case with 4 log entries for a valid, found, auto-routed interaction;
  - a review case with several codes;
  - an invalid classification gives `general`, `invalid_output`, no enrichment and 3 log entries;
  - a second call returns the same case and adds no rows;
  - two concurrent calls give one case;
  - "classify first" and "enrich first" errors store nothing;
  - an enrichment made from an older classification isn't used;
  - the database rejects `needs_review` that disagrees with `reason_codes`, an unknown team, and a second case for the same interaction;
  - no log entry contains `raw_text` or an identifier value.

## 4. CLI

4.1. Write `src/cli/route.ts` with the script `route`. For an ID or `external_id` it runs `routeInteraction` and prints:
  - the team, whether the case needs review, and each reason code with its detail;
  - the four log entries (step, rule applied, a short output);
  - "existing case" when nothing new was written.

  It prints placeholders, never identifier values. Errors go to stderr with exit code 1.

4.2. Integration test for the CLI: an auto-routed case, a review case, and a re-run that prints "existing case".

## 5. Evaluation

5.1. Extend `eval/metrics/score.ts` with the routing result for each message, using `eval/lib/route-message.ts`. Extend `eval/metrics/aggregate.ts` with:
  - routing accuracy;
  - must-review recall and precision, and the true-positive, false-positive and false-negative counts;
  - the review rate;
  - the count for each reason code;
  - whether each labelled reason was caught;
  - the IDs of missed must-review messages.

  All of these are overall and per language.

5.2. Add a "Routing" section to `report.md` and `report.html`, and the versions (`enrich.v1`, `route.v1`) and the seed hash to the settings table.

5.3. Update the unit tests in `test/eval/`, and regenerate the golden `test/eval/fixtures/report.md` with `UPDATE_GOLDEN=1`. Check the diff contains only the new sections.

5.4. Run `npm run eval:report` on both kept runs and commit the regenerated `metrics.json`, `report.md` and `report.html`. Their `outputs.jsonl` and `run.json` don't change.

## 6. Docs and constitution

6.1. Update [tech-stack.md](../../tech-stack.md):
  - in "Routing rules", the threshold, the no-identifiers rule (technical faults only), the two mismatch rules, the reason codes and `route.v1`;
  - in "Data model", the final `cases` and `decision_log` fields;
  - in "Intents, teams and labels", where the runtime reasons live;
  - in "Evaluation", the routing metrics.

6.2. Update `README.md`: `npm run route`, the demo order (`… classify`, `enrich`, `route`), and the routing results from the kept `classify.v2` run.

## 7. Verify and demo

7.1. Run lint, format check, type check, unit tests, build, audit, `db:migrate` and the integration tests.

7.2. Demo on a fresh, separate database (as in P06): `crm:seed`, `dataset:load`, then, **after asking** (about $0.12), `npm run classify` on six messages:
  - auto-routed, no review;
  - a cancellation;
  - a low-confidence message;
  - `not_found` or `ambiguous`;
  - a CRM mismatch (unmatched key);
  - a technical fault with no identifiers.

  Then `npm run enrich` and `npm run route` on each (free), and `route` once more on one of them to show "existing case". Choose the message IDs from the dataset-wide test's output. Keep the output for the PR description.

7.3. Record results in requirements.md (Results). Work through [validation.md](validation.md). After review, mark P07 done in [roadmap.md](../../roadmap.md), push, open the PR and ask before merging.
