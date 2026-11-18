# Triage dataset

Synthetic, labelled customer messages for Merelo, a fictional Czech and Slovak internet, mobile and TV provider. Every evaluation in this project runs on these files. **No real customer data**: messages are written by a model from labels chosen in code, and all identifiers are generated in code in formats that cannot belong to a real person (see [the labelling guide](../labelling-guide.md#identifier-formats-why-they-cannot-be-real)).

| File | Contents |
| --- | --- |
| `dataset.jsonl` | 100 messages (60 cs, 20 sk, 20 en) with final labels |
| `injection.jsonl` | 15 messages with instructions aimed at the model, for P11 |
| `.work/` | Intermediate files: the plan, generated messages, grader answers, review log and run log. Kept in git because they cost money to produce and record how every label was reached. |

The record format is defined by [`eval/schema/dataset-record.schema.ts`](../schema/dataset-record.schema.ts). Use `final` labels for evaluation; `chosen` are the labels the message was generated from, and `graders` are the two models' independent answers.

## How the dataset is built

1. **Plan (labels first)** — `npm run dataset:plan`. Draws the label combinations from a fixed seed (`20261118`) so that every intent and language is covered, including deliberately ambiguous cases, and generates the identifiers each message must contain. No model is called.
2. **Generate** — `npm run dataset:generate`. One model call per planned entry writes the message for its labels, channel, register and language, and must include the planned identifiers verbatim. Code checks each message (identifiers present, no real operator names) and retries up to twice.
3. **Grade** — `npm run dataset:grade`. Two different models label every dataset message independently, using the labelling guide only. Neither sees the chosen labels or the other's answer. Output is validated against a JSON Schema.
4. **Review** — `npm run dataset:review`. A person reviews every message where the chosen labels and both graders do not all agree on intent, urgency, must-review, service type and area (or where a grader's output was invalid), plus a fixed-seed random sample of 10 messages where all three agree. The reviewer accepts, corrects or sends the message back for rewriting. All injection messages are reviewed in full.
5. **Finalize** — `npm run dataset:finalize` writes `dataset.jsonl` and `injection.jsonl` with `final` labels, after validating every record.
6. **Statistics** — `npm run dataset:stats` prints the tables below and rewrites them in this file.

Steps 2 and 3 call paid models. Each run supports `--dry-run` (prints the planned calls and an estimated cost, makes no calls), asks for confirmation, and stops before exceeding `--max-cost` (default $10). Every real run is logged in `.work/runs.jsonl` and summarised under "Runs" below.

The generator and graders are separate from the triage prompts evaluated later, so the pipeline is never scored on labels it produced itself.

<!-- stats:start -->
## Label statistics

100 dataset messages and 15 injection messages. Counts use the final labels.

### Intent × language

| intent | cs | sk | en | total |
| --- | --- | --- | --- | --- |
| billing_question | 10 | 4 | 3 | 17 |
| technical_fault | 10 | 4 | 3 | 17 |
| tariff_change | 10 | 3 | 4 | 17 |
| cancellation | 10 | 3 | 3 | 16 |
| complaint | 10 | 3 | 4 | 17 |
| other | 10 | 3 | 3 | 16 |
| **total** | 60 | 20 | 20 | 100 |

### Channel, urgency and must-review

| channel | messages |
| --- | --- |
| email | 40 |
| chat | 35 |
| call | 25 |

| urgency | messages |
| --- | --- |
| low | 25 |
| normal | 50 |
| high | 25 |

| must_review | messages |
| --- | --- |
| true | 38 |
|   of which unclear | 6 |
| false | 62 |

| design | messages |
| --- | --- |
| designed ambiguous | 15 |
| mixed Czech/Slovak | 5 |
| with identifiers | 70 |

## Review statistics

|  | dataset | injection |
| --- | --- | --- |
| needed review (disagreement or invalid grader) | 17 | 15 |
| random agreement sample | 10 | – |
| reviewed by a person | 27 | 15 |
| labels changed by the reviewer | 6 | 0 |
|   of which in the agreement sample | 0 | – |
| messages rewritten | 0 | 0 |

Labels changed by the reviewer, per field:

| field | messages |
| --- | --- |
| intent | 0 |
| urgency | 6 |
| must_review | 1 |
| review_reasons | 1 |
| service_type | 0 |
| area | 0 |

### Agreement with the final labels

Share of dataset messages where each label source matches the final labels.

| source | intent | urgency | must_review | service_type | area | all five | invalid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chosen (generator) | 100% | 94% | 99% | 100% | 100% | 94% | 0 |
| grader A (claude-sonnet-5-5) | 100% | 97% | 99% | 100% | 100% | 96% | 0 |
| grader B (claude-haiku-5-5) | 100% | 92% | 100% | 98% | 100% | 90% | 0 |

## Runs

Paid model runs used to build the dataset (from `.work/runs.jsonl`).

| script | date | jobs | calls by model | input / cached / output tokens | cost (USD) | note |
| --- | --- | --- | --- | --- | --- | --- |
| dataset:generate | 2026-11-18 | 3/3 | claude-opus-5-5 ×3 | 16840 / 0 / 1370 | 0.11 | prompt generate.v1, model claude-opus-5-5 |
| dataset:generate | 2026-11-18 | 112/112 | claude-opus-5-5 ×112 | 16078 / 610960 / 75218 | 1.81 | prompt generate.v1, model claude-opus-5-5 |
| dataset:grade | 2026-11-18 | 100/100 | claude-sonnet-5-5 ×100, claude-haiku-5-5 ×100 | 68944 / 509184 / 14109; 63640 / 514488 / 26587 | 0.42 | prompt grade.v1, graders claude-sonnet-5-5 + claude-haiku-5-5 |

**Total cost: $2.34.**
<!-- stats:end -->
