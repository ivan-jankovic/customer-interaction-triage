# Phase 7 — Routing rules and decision log: Validation

The branch `p07-routing-rules-decision-log` can be merged when every check below passes.

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

## Routing rules

- [x] A valid classification is routed to `INTENT_TO_TEAM[intent]` for all six intents. **(test)**
- [x] Invalid and errored classifications are routed to `general` with `invalid_output` / `classification_error`, and need review. **(test)**
- [x] `cancellation` and `complaint` intents always need review, with their own code. **(test)**
- [x] Confidence 0.69 gives `low_confidence`; 0.7 does not. **(test)**
- [x] `not_found` gives `customer_not_found`, and `ambiguous` gives `customer_ambiguous`. **(test)**
- [x] `no_identifiers` gives `customer_unidentified` for `technical_fault` only; a `billing_question` or `tariff_change` with no identifiers and no other reason is routed without review. **(test)**
- [x] `found` with an unmatched placeholder gives `crm_mismatch_unmatched_key`. **(test)**
- [x] `found` with a classified service type the customer has no service of gives `crm_mismatch_service_type`. A terminated service of that type, or `unknown`, does not. **(test)**
- [x] All rules that apply are kept, in the order of requirements.md; `needs_review` is true exactly when there is at least one code. **(test)**
- [x] No rule detail contains an identifier value. **(test)**

## Dataset-wide check

- [x] Routing the kept `classify.v2` outputs sends every message labelled `must_review` to review (recall 100%), gives every message its `expected_team`, and catches every `unclear` message with `low_confidence`. **(test)**

## Storage and the routing step

- [x] Migration `0006` creates `cases` and `decision_log` with their constraints and indexes; rolling back removes them. **(test)**
- [x] `routeInteraction` writes one case and its decision-log entries in one transaction: 4 entries for a valid classification, and 3 for an invalid or errored one (no `enrich`). **(test)**
- [x] It uses the latest valid classification and only an enrichment made from it. It falls back to the latest attempt when none is valid. **(test)**
- [x] It fails clearly, storing nothing, when there is no classification ("classify first") or no matching enrichment ("enrich first"). **(test)**
- [x] Routing an interaction twice, one after the other or concurrently, leaves exactly one case and one set of log entries. **(test)**
- [x] The database rejects a second case for an interaction, an unknown team, and `needs_review` that disagrees with `reason_codes`. **(test)**
- [x] No `decision_log` entry contains the message text, the summary or an identifier value. **(test)**

## CLI and demo

- [x] `npm run route -- <id | external_id>` prints the team, the review flag, the reason codes with details and the decision log; a re-run prints "existing case"; it prints no identifier value. **(test)**
- [x] On a fresh separate database, after `crm:seed` and `dataset:load` and the user's go-ahead for six `classify` calls, `npm run route` shows six cases: auto-routed, cancellation, low confidence, not found or ambiguous, CRM mismatch, and a technical fault with no identifiers. The output is in the PR description. **(manual)**

## Evaluation

- [x] `metrics.json` and the reports have routing accuracy, must-review recall and precision with counts, the review rate, the count for each reason code, whether each labelled reason was caught, and the missed IDs, overall and per language. **(test)**
- [x] The report's settings table records `enrich.v1`, `route.v1` and the seed hash. **(test)**
- [x] `npm run eval:report` reproduces the new reports byte for byte. **(test)**
- [x] Both kept runs are recomputed; their committed `outputs.jsonl` and `run.json` are unchanged. **(manual)**
- [x] The golden report fixture's diff contains only the new routing content. **(manual)**

## Specs updated

- [x] [tech-stack.md](../../tech-stack.md) has the routing rules, reason codes, threshold, final `cases` and `decision_log` fields, and the routing metrics. **(manual)**
- [x] `README.md` explains `npm run route`, the demo order and the routing results. **(manual)**
- [x] P07 is marked done in [roadmap.md](../../roadmap.md) after review. **(manual)**

## Scope checks

- [x] No queue, worker or end-to-end "process" command (P08); no review listing or corrections (P09); `investigation_inconclusive` is never produced (P10). **(manual)**
- [x] The prompts and `summary-judge.v1` are unchanged (registry hashes unchanged). **(test)**
- [x] No model call outside the six demo classifications. **(manual)**
