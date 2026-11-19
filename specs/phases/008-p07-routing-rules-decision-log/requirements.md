# Phase 7 — Routing rules and decision log: Requirements

## Context

This is phase P07 in [roadmap.md](../../roadmap.md). The pipeline steps built so far are:

- P02 stores interactions.
- P05 masks them.
- P03 classifies them, with the model seeing masked text only.
- P06 enriches them: it finds the customer in the mock CRM and the known outages.

Each step records facts in its own table. None of them decides anything: no step says which team gets a message, or whether a person must look at it.

This phase builds step 6 (Routing) and the first part of step 7 (Case record) of [mission.md](../../mission.md). Plain code turns the stored outputs into one **case** per interaction: a target team, whether the case needs review, and the reason codes. A **decision log** records how the case was reached. It serves these principles:

- **Decisions are made in code:** no prompt decides a route.
- **People decide the hard cases:** cancellations, complaints, low confidence and CRM problems go to review.
- **Auditable:** for every case you can see what each step returned and which rule decided.

It also extends the evaluation with routing accuracy and recall on must-review, the main success criterion in the mission.

## Scope

In scope:

- **Routing rules** (`src/pipeline/route.ts`, version `route.v1`): a pure function from the classification, the enrichment and the found customer's service types to a team, a review flag and reason codes (see Routing rules).
- **Reason codes** added to `src/taxonomy.ts` as runtime review reasons, next to the dataset's `REVIEW_REASONS`.
- **Storage** (migration `0006`): a `cases` table (one case per interaction) and a `decision_log` table (one entry per pipeline step), written in one transaction.
- **`npm run route -- <id | external_id>`**: routes one interaction from what is stored (masking, current classification, enrichment), writes the case and its log, and prints them. It is free (no model). If the interaction already has a case, it prints the existing case and writes nothing.
- **Evaluation:** routing metrics scored from the stored outputs. The scoring masks the text, enriches against the in-memory seed CRM and routes; no model is called. The two kept runs are recomputed with `npm run eval:report`.
- **Tests:**
  - unit tests for every rule;
  - a dataset-wide unit test that routes the kept `classify.v2` run's 100 outputs;
  - integration tests for the migration, the routing step and the CLI.
- **Docs:** [tech-stack.md](../../tech-stack.md) (the routing rules and reason codes, and the final `cases` and `decision_log` fields) and the README. Approving this spec approves these edits.

Out of scope (later phases):

- Running routing from a queue worker, and an end-to-end "process" command (P08). Today routing runs from the CLI after `classify` and `enrich`.
- Listing, confirming or correcting cases, and re-routing a case (P09). A case is final once written; a correction is a review.
- The `investigation_inconclusive` reason (P10). P07 leaves room for it in the code list but never produces it.
- Comparing tariffs against the CRM. The seed's tariffs are random (P06 Results), so this rule would first need a new version of the seed generator.
- `high` urgency as a review reason. Urgency is recorded on the classification but does not change the route in `route.v1`.
- A paid evaluation run. The new metrics come from the outputs already stored.

## Routing rules (`route.v1`)

### Which inputs are used

- **Classification:**
  - the current one is the latest valid row;
  - if the interaction has no valid row but has attempts, the latest attempt (invalid or error) is used;
  - with no attempt at all, routing fails with "classify first".
- **Enrichment:**
  - for a valid classification, the latest enrichment made from that classification (`enrichments.classification_id`);
  - if there is none, routing fails with "enrich first";
  - for an invalid or errored attempt, no enrichment is used (P06 needs a valid classification).
- **The found customer's service types:** read through `CrmLookup.servicesOfCustomer`. They are passed to the rules as data, so the rules stay pure.

### Team

- **Valid classification:** the team comes from the intent, through `INTENT_TO_TEAM` in `src/taxonomy.ts`.
- **Invalid or errored classification:** `general`. Every case then has a team. Decided during spec review.

### Review reasons

A case needs review exactly when it has at least one reason code. All the rules are checked, and every one that applies adds its code (they don't stop at the first match). Codes are listed in this order:

| Reason code | When | Source |
| --- | --- | --- |
| `invalid_output` | The classification outcome is `invalid`. | Classification |
| `classification_error` | The classification outcome is `error` (the API call failed). | Classification |
| `cancellation` | The intent is `cancellation`. | Intent rule (as in the dataset) |
| `complaint` | The intent is `complaint`. | Intent rule (as in the dataset) |
| `low_confidence` | `confidence < 0.7` (`REVIEW_CONFIDENCE_THRESHOLD`). | Classification |
| `customer_not_found` | The enrichment outcome is `not_found`. | Enrichment |
| `customer_ambiguous` | The enrichment outcome is `ambiguous`. | Enrichment |
| `customer_unidentified` | The outcome is `no_identifiers` **and** the intent is `technical_fault`. | Enrichment + intent |
| `crm_mismatch_unmatched_key` | The outcome is `found`, but at least one of the message's keys matched no one (`unmatched_placeholders` is not empty). | Enrichment |
| `crm_mismatch_service_type` | The outcome is `found`, the classified service type is `internet`, `mobile` or `tv`, and the customer has no service of that type, active or terminated. | Enrichment + CRM |

Notes on the rules:

- **`customer_unidentified` is for technical faults only.** A fault can't be checked against the customer's line status or recent tickets without knowing who the customer is, and P10's agent needs a customer ID. The billing and sales teams routinely ask the customer for their account number, so `billing_question` and `tariff_change` without identifiers are routed without review. Cancellations and complaints are reviewed anyway, and `other` needs no account.
- **The low-confidence rule replaces the dataset's `unclear` label at runtime**: the model can't label its own message "unclear", but it reports how sure it is. In the kept `classify.v2` run, all 6 messages labelled `unclear` have a confidence of 0.6 or lower.
- **Two mismatch codes, not one `crm_mismatch`**, so the review queue (P09) can show which check failed.
- **The threshold and the rule sets are constants** in `route.ts`. Changing them is a new `ROUTER_VERSION`.

### What is recorded

For every rule that fired: the reason code and a short detail without personal data. For example `confidence 0.55 < 0.7`, `[EMAIL_1] matched no customer` or `classified mobile, customer has internet, tv`. Details name placeholders and IDs, never identifier values.

## Data

### Migration `0006`: `cases` and `decision_log`

`cases`: one row per interaction, written once.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` (uuidv7) | |
| `interaction_id` | `uuid` FK, **unique** | One case per interaction (P08: "exactly one case") |
| `classification_id` | `uuid` FK | The classification attempt used (valid, or the latest invalid one) |
| `enrichment_id` | `uuid` FK, nullable | Null exactly when the classification is not valid |
| `customer_id` | `uuid` FK, nullable | The found customer, if any |
| `target_team` | `text` | One of `TEAMS` (checked) |
| `needs_review` | `boolean` | True exactly when `reason_codes` is not empty (check constraint) |
| `reason_codes` | `jsonb` | `["cancellation", "customer_not_found", …]`, in the order of the table above |
| `router_version` | `text` | `route.v1` |
| `created_at` | `timestamptz` | |

`decision_log`: one entry per pipeline step of the case, written in the same transaction as the case.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` (uuidv7) | |
| `case_id` | `uuid` FK | |
| `seq` | `integer` | 1–4, in pipeline order; unique per case |
| `step` | `text` | `mask` \| `classify` \| `enrich` \| `route` (checked); unique per case |
| `input_summary` | `jsonb` | What the step read: row IDs, channel, placeholder types and counts. No text, no identifier values. |
| `output` | `jsonb` | What it produced. See below. |
| `rule_applied` | `text` | The version or rule that decided: `mask.v1`, `classify.v2 / claude-opus-5-5`, `enrich.v1`, `route.v1` |
| `created_at` | `timestamptz` | |

What each step's `output` holds:

- `mask`: the placeholders by type.
- `classify`: the outcome, intent, urgency, service type, area and confidence. No summary text, because it is already in `classifications`.
- `enrich`: the outcome, customer ID, candidate count, unmatched placeholders, area, area source and outage IDs.
- `route`: the team, `needs_review` and every rule that fired, with its reason code and detail.

For an invalid or errored classification, the case has 3 entries (no `enrich`).

## Evaluation

Scored for every run, from `outputs.jsonl` plus the dataset and `eval/data/crm/seed.json`, with no model. Per message, the scoring:

1. masks the text with `mask.v1`;
2. enriches against the in-memory CRM, with the classified area and service type and the seed's `received_at`;
3. routes with `route.v1`.

Added to `metrics.json`, `report.md` and `report.html`, overall and per language:

- **Routing accuracy:** the share of messages whose team equals the label's `expected_team`. Invalid outputs count as `general`.
- **Must-review:** recall and precision against the label's `must_review`, the counts (true positives, false positives, false negatives) and the **review rate** (the share of all messages sent to review).
- **Per reason code:** how many messages it fired on. For each labelled review reason, whether it was caught: `cancellation` by `cancellation`, `complaint` by `complaint`, `unclear` by `low_confidence`. An `unclear` message caught by another code counts as caught for must-review recall, but not for the `unclear` → `low_confidence` row.
- **Missed must-review messages, listed by ID**, so a drop in recall is easy to look into.

`run.json` already records the masker; the report also records `enrich.v1`, `route.v1` and the seed hash. The kept runs `classify.v1` and `classify.v2` are recomputed and their regenerated reports committed.

## Decisions

### Requirements

| Decision | Choice | Why |
| --- | --- | --- |
| Confidence threshold | Review when `confidence < 0.7` | Catches every `unclear` message (all at 0.6 or lower) with two 0.05 steps to spare. In the kept run, only one message that needs no review (msg-055 at 0.6) is reviewed for low confidence alone. 0.8 was chosen first and changed to 0.7 during spec review: on the kept run 0.8 sent 3 more messages to review for low confidence alone, and recall was the same. Decided during spec review. |
| No identifiers | Review (`customer_unidentified`) only for `technical_fault` | A missing customer blocks only the technical check; other teams ask the customer for the account number. The rule never affects must-review recall (no labelled reason depends on it). It was first set to billing, technical fault and tariff change; it was narrowed during spec review because on the kept run that sent 23 messages to review for this reason alone, and technical faults only sends 9. Decided during spec review. |
| CRM mismatch | Two rules: a key that matched no one while a customer was found, and a classified service type the customer doesn't hold | Both can be checked with the data P06 stores. Tariff comparison would need a new seed generator. Decided during spec review. |
| No intent | `general` + review (`invalid_output` / `classification_error`) | Every case has a team, and invalid output never decides a route. Decided during spec review. |
| Rules evaluated | All rules, all codes kept | The reviewer sees every reason, not only the first. |

### Plan

| Decision | Choice | Why |
| --- | --- | --- |
| Trigger | `npm run route -- <id>` reads what earlier steps stored; P08's worker will call the same function | Free to run, and it matches `enrich` in P06. Decided during spec review. |
| Re-run | One case per interaction (unique). A second run returns the existing case and writes nothing. | Idempotent, as P08 requires. Re-routing after a correction is P09's job. Decided during spec review. |
| Decision log | One entry per step (`mask`, `classify`, `enrich`, `route`); the `route` entry lists every rule that fired | Shows the whole path of a case in four rows. Decided during spec review. |
| Code shape | Pure `route(input)` in `src/pipeline/route.ts`; storage in `src/db/cases.ts` | The rules are tested without a database, and the eval uses the same function. |
| Concurrent runs | The insert relies on the unique `interaction_id`. On a conflict, the transaction is rolled back and the existing case is returned. | Safe when P08 runs two jobs for one message. |

### Validation

| Decision | Choice | Why |
| --- | --- | --- |
| Eval metrics | Scored from stored outputs. The kept runs are recomputed with `eval:report`; there is no paid run. | Routing is deterministic code, so the model's stored answers are enough. Decided during spec review. |
| Dataset-wide test | A unit test routes the kept `classify.v2` outputs and asserts 100% recall on must-review, and that every team equals `expected_team` | A later rule change that drops a needed review fails CI. Decided during spec review. |
| Demo | 6 paid messages (about $0.12, after asking): auto-routed, cancellation, low confidence, not found or ambiguous, CRM mismatch, and a technical fault with no identifiers | Covers every kind of reason. Decided during spec review. |

## Notes

- **Expected review rate.** On the kept `classify.v2` run, with the seed's expected enrichment, 55 of 100 messages go to review (17 more than the 38 the labels ask for, none missed), before counting the 3 unmatched-key mismatches. So the total is 55–58%. Most come from the intent (cancellation and complaint). Of the rest:
  - 9 technical faults are reviewed only because they have no identifiers;
  - 6 messages are reviewed only for low confidence.

  Precision on must-review is low by design. The report shows the rate and the count for each code, so a later phase (P17) can tune the threshold with data.
- **`crm_mismatch_service_type` never fires on the dataset.** Every found customer in the seed holds the labelled service type. It is covered by unit tests with fixtures, and fires on the dataset only when the model misclassifies the service type.
- **The golden report fixture changes** (`test/eval/fixtures/report.md`): it gets the routing sections. It is regenerated with `UPDATE_GOLDEN=1` and checked by reading the diff.
- **The scoring needs `seed.json`.** If the seed changes, the routing metrics of old runs change too. The report records the seed hash so this is visible.
- **`REVIEW_REASONS` in `taxonomy.ts`** stays the dataset's label list. The runtime reason codes are a separate list (`REASON_CODES`), because a label and a reason code are different things.
