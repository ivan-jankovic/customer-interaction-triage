# Evaluation 20261119-232004-full-claude-sonnet-5-5-classify.v2

| Setting | Value |
| --- | --- |
| Set | full (100 messages) |
| Classifier | claude-sonnet-5-5, effort low, prompt classify.v2 |
| Summary judge | claude-haiku-5-5, effort low, prompt summary-judge.v1 |
| Masking | mask.v1 |
| Routing | enrich.v1, route.v4, CRM seed sha256 f5c8731da893 |
| Dataset | eval/data/dataset.jsonl (sha256 94ee3b2f479d) |
| Code | 8b8482c5ae6a |
| Started | 2026-11-19T23:20:04.685Z |
| Complete | yes |

The scoring is deterministic: `npm run eval:report -- 20261119-232004-full-claude-sonnet-5-5-classify.v2` recomputes this report from the stored outputs. A new `npm run eval` calls the model again, and its numbers may differ slightly.

## Overall

| Metric | Value |
| --- | --- |
| Messages | 100 |
| Valid outputs | 100.0% (invalid: 0, errors: 0, fallbacks: 0) |
| Intent accuracy | 100.0% |
| Intent macro F1 | 1.000 |
| Urgency accuracy | 85.0% |
| Language accuracy | 100.0% |
| Service type accuracy | 100.0% |
| Area accuracy | 100.0% |
| Identifiers precision / recall | 100.0% / 100.0% |
| Identifier lists exactly right | 100.0% |
| Routing accuracy (team) | 100.0% |
| Must-review recall / precision | 100.0% / 67.9% |
| Sent to review | 56.0% |
| Summary faithful / complete (1–5) | 4.88 / 4.45 |
| Summaries with personal data | 0.0% |

Invalid outputs and errors count as wrong in every accuracy.

## By language

| Metric | cs (n=60) | sk (n=20, indicative) | en (n=20, indicative) |
| --- | --- | --- | --- |
| Valid outputs | 100.0% | 100.0% | 100.0% |
| Intent | 100.0% | 100.0% | 100.0% |
| Urgency | 83.3% | 90.0% | 85.0% |
| Language | 100.0% | 100.0% | 100.0% |
| Service type | 100.0% | 100.0% | 100.0% |
| Area | 100.0% | 100.0% | 100.0% |
| Identifiers P / R | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% |
| Routing | 100.0% | 100.0% | 100.0% |
| Must-review R / P | 100.0% / 63.9% | 100.0% / 80.0% | 100.0% / 70.0% |
| Sent to review | 60.0% | 50.0% | 50.0% |
| Summary faithful / complete | 4.88 / 4.43 | 4.90 / 4.45 | 4.85 / 4.50 |

Groups under 30 messages are indicative only: one message moves their accuracy by several points.

## Intents

| Intent | Labelled | Predicted | Correct | Precision | Recall | F1 |
| --- | --- | --- | --- | --- | --- | --- |
| `billing_question` | 17 | 17 | 17 | 100.0% | 100.0% | 1.000 |
| `technical_fault` | 17 | 17 | 17 | 100.0% | 100.0% | 1.000 |
| `tariff_change` | 17 | 17 | 17 | 100.0% | 100.0% | 1.000 |
| `cancellation` | 16 | 16 | 16 | 100.0% | 100.0% | 1.000 |
| `complaint` | 17 | 17 | 17 | 100.0% | 100.0% | 1.000 |
| `other` | 16 | 16 | 16 | 100.0% | 100.0% | 1.000 |

### Confusion matrix

Rows are the labelled intents, columns the predicted ones; `invalid` collects invalid outputs and errors.

| label \ predicted | `billing_question` | `technical_fault` | `tariff_change` | `cancellation` | `complaint` | `other` | `invalid` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `billing_question` | **17** | 0 | 0 | 0 | 0 | 0 | 0 |
| `technical_fault` | 0 | **17** | 0 | 0 | 0 | 0 | 0 |
| `tariff_change` | 0 | 0 | **17** | 0 | 0 | 0 | 0 |
| `cancellation` | 0 | 0 | 0 | **16** | 0 | 0 | 0 |
| `complaint` | 0 | 0 | 0 | 0 | **17** | 0 | 0 |
| `other` | 0 | 0 | 0 | 0 | 0 | **16** | 0 |

## Routing

Each message is masked, enriched against the mock CRM (enrich.v1) with the classified area and service type, and routed (route.v4), as the pipeline would. No model is called. Invalid outputs and errors go to `general` and to review.

| Must-review | Value |
| --- | --- |
| Labelled must-review | 38 |
| Sent to review | 56 (56.0% of all messages) |
| Caught (true positives) | 38 |
| Reviewed but not labelled (false positives) | 18 |
| Missed (false negatives) | 0 |
| Recall / precision | 100.0% / 67.9% |

### Reason codes

Messages each code fired on; a message can have several.

| Code | Messages |
| --- | --- |
| `processing_failed` | 0 |
| `invalid_output` | 0 |
| `classification_error` | 0 |
| `cancellation` | 16 |
| `complaint` | 17 |
| `low_confidence` | 8 |
| `customer_not_found` | 5 |
| `customer_ambiguous` | 5 |
| `customer_unidentified` | 9 |
| `crm_mismatch_unmatched_key` | 3 |
| `crm_mismatch_service_type` | 0 |
| `investigation_inconclusive` | 0 |
| `suspicious_output` | 0 |

### Labelled reasons

Whether each labelled review reason got its own code. A message caught by another code still counts for must-review recall.

| Labelled reason | Caught by | Labelled | Caught | Rate |
| --- | --- | --- | --- | --- |
| `cancellation` | `cancellation` | 16 | 16 | 100.0% |
| `complaint` | `complaint` | 17 | 17 | 100.0% |
| `unclear` | `low_confidence` | 6 | 6 | 100.0% |

### Missed must-review messages

None: every message labelled must-review was sent to review.

## Confidence

Mean confidence: 0.88 when the intent was right, – when it was wrong.

| Confidence | Messages | Intent accuracy |
| --- | --- | --- |
| < 0.5 | 2 | 100.0% |
| 0.5–0.8 | 7 | 100.0% |
| 0.8–0.9 | 26 | 100.0% |
| ≥ 0.9 | 65 | 100.0% |

## Worst errors

No wrong intents among the valid outputs.

## Summaries

Summaries graded by the judge: 100. Valid outputs not graded (judge output invalid or failed): 0.

## Cost and latency

|  | Classifier | Judge | Total |
| --- | --- | --- | --- |
| Cost | $0.3224 | $0.0118 | $0.3342 |
| Input tokens | 48,725 | 57,998 |  |
| Cache reads | 288,960 | 82,176 |  |
| Cache writes | 12,040 | 3,424 |  |
| Output tokens | 13,710 | 9,435 |  |

Cost per message: $0.0033.

Classifier latency: p50 2.0 s, p95 2.4 s, max 3.2 s.
