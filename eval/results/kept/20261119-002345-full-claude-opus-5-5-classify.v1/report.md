# Evaluation 20261119-002345-full-claude-opus-5-5-classify.v1

| Setting | Value |
| --- | --- |
| Set | full (100 messages) |
| Classifier | claude-opus-5-5, effort low, prompt classify.v1 |
| Summary judge | claude-haiku-5-5, effort low, prompt summary-judge.v1 |
| Masking | none (raw text sent to the model) |
| Routing | enrich.v1, route.v2, CRM seed sha256 b411896f8110 |
| Dataset | eval/data/dataset.jsonl (sha256 94ee3b2f479d) |
| Code | b01ad5e8ddbd |
| Started | 2026-11-19T00:23:45.135Z |
| Complete | yes |

The scoring is deterministic: `npm run eval:report -- 20261119-002345-full-claude-opus-5-5-classify.v1` recomputes this report from the stored outputs. A new `npm run eval` calls the model again, and its numbers may differ slightly.

## Overall

| Metric | Value |
| --- | --- |
| Messages | 100 |
| Valid outputs | 100.0% (invalid: 0, errors: 0, fallbacks: 0) |
| Intent accuracy | 100.0% |
| Intent macro F1 | 1.000 |
| Urgency accuracy | 89.0% |
| Language accuracy | 100.0% |
| Service type accuracy | 99.0% |
| Area accuracy | 99.0% |
| Identifiers precision / recall | 100.0% / 100.0% |
| Identifier lists exactly right | 100.0% |
| Routing accuracy (team) | 100.0% |
| Must-review recall / precision | 100.0% / 65.5% |
| Sent to review | 58.0% |
| Summary faithful / complete (1–5) | 4.90 / 4.41 |
| Summaries with personal data | 0.0% |

Invalid outputs and errors count as wrong in every accuracy.

## By language

| Metric | cs (n=60) | sk (n=20, indicative) | en (n=20, indicative) |
| --- | --- | --- | --- |
| Valid outputs | 100.0% | 100.0% | 100.0% |
| Intent | 100.0% | 100.0% | 100.0% |
| Urgency | 90.0% | 90.0% | 85.0% |
| Language | 100.0% | 100.0% | 100.0% |
| Service type | 100.0% | 100.0% | 95.0% |
| Area | 98.3% | 100.0% | 100.0% |
| Identifiers P / R | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% |
| Routing | 100.0% | 100.0% | 100.0% |
| Must-review R / P | 100.0% / 62.2% | 100.0% / 80.0% | 100.0% / 63.6% |
| Sent to review | 61.7% | 50.0% | 55.0% |
| Summary faithful / complete | 4.90 / 4.37 | 4.79 / 4.42 | 5.00 / 4.53 |

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

Each message is masked, enriched against the mock CRM (enrich.v1) with the classified area and service type, and routed (route.v2), as the pipeline would. No model is called. Invalid outputs and errors go to `general` and to review.

| Must-review | Value |
| --- | --- |
| Labelled must-review | 38 |
| Sent to review | 58 (58.0% of all messages) |
| Caught (true positives) | 38 |
| Reviewed but not labelled (false positives) | 20 |
| Missed (false negatives) | 0 |
| Recall / precision | 100.0% / 65.5% |

### Reason codes

Messages each code fired on; a message can have several.

| Code | Messages |
| --- | --- |
| `processing_failed` | 0 |
| `invalid_output` | 0 |
| `classification_error` | 0 |
| `cancellation` | 16 |
| `complaint` | 17 |
| `low_confidence` | 10 |
| `customer_not_found` | 5 |
| `customer_ambiguous` | 5 |
| `customer_unidentified` | 9 |
| `crm_mismatch_unmatched_key` | 3 |
| `crm_mismatch_service_type` | 0 |
| `investigation_inconclusive` | 0 |

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

Mean confidence: 0.86 when the intent was right, – when it was wrong.

| Confidence | Messages | Intent accuracy |
| --- | --- | --- |
| < 0.5 | 2 | 100.0% |
| 0.5–0.8 | 10 | 100.0% |
| 0.8–0.9 | 33 | 100.0% |
| ≥ 0.9 | 55 | 100.0% |

## Worst errors

No wrong intents among the valid outputs.

## Summaries

Summaries graded by the judge: 97. Valid outputs not graded (judge output invalid or failed): 3.

## Cost and latency

|  | Classifier | Judge | Total |
| --- | --- | --- | --- |
| Cost | $0.6620 | $0.0116 | $0.6736 |
| Input tokens | 48,428 | 57,550 |  |
| Cache reads | 325,600 | 85,600 |  |
| Cache writes | 0 | 0 |  |
| Output tokens | 16,901 | 10,001 |  |

Cost per message: $0.0067.

Classifier latency: p50 2.2 s, p95 3.1 s, max 4.8 s.
