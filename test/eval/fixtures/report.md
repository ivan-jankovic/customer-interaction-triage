# Evaluation 20261119-120000-full-claude-opus-5-5-classify.v1

| Setting | Value |
| --- | --- |
| Set | full (8 messages) |
| Classifier | claude-opus-5-5, effort low, prompt classify.v1 |
| Summary judge | claude-haiku-5-5, effort low, prompt summary-judge.v1 |
| Masking | none (raw text sent to the model) |
| Routing | enrich.v1, route.v2, CRM seed sha256 513295177e5e |
| Dataset | eval/data/dataset.jsonl (sha256 5c8d651aff3d) |
| Code | 0123456789ab |
| Started | 2026-11-19T12:00:00.000Z |
| Complete | yes |

The scoring is deterministic: `npm run eval:report -- 20261119-120000-full-claude-opus-5-5-classify.v1` recomputes this report from the stored outputs. A new `npm run eval` calls the model again, and its numbers may differ slightly.

## Overall

| Metric | Value |
| --- | --- |
| Messages | 8 |
| Valid outputs | 75.0% (invalid: 1, errors: 1, fallbacks: 1) |
| Intent accuracy | 50.0% |
| Intent macro F1 | 0.472 |
| Urgency accuracy | 50.0% |
| Language accuracy | 62.5% |
| Service type accuracy | 62.5% |
| Area accuracy | 62.5% |
| Identifiers precision / recall | 50.0% / 40.0% |
| Identifier lists exactly right | 37.5% |
| Routing accuracy (team) | 62.5% |
| Must-review recall / precision | 80.0% / 66.7% |
| Sent to review | 75.0% |
| Summary faithful / complete (1–5) | 4.20 / 4.00 |
| Summaries with personal data | 20.0% |

Invalid outputs and errors count as wrong in every accuracy.

## By language

| Metric | cs (n=4, indicative) | sk (n=2, indicative) | en (n=2, indicative) |
| --- | --- | --- | --- |
| Valid outputs | 100.0% | 50.0% | 50.0% |
| Intent | 50.0% | 50.0% | 50.0% |
| Urgency | 75.0% | 0.0% | 50.0% |
| Language | 100.0% | 50.0% | 0.0% |
| Service type | 75.0% | 50.0% | 50.0% |
| Area | 75.0% | 50.0% | 50.0% |
| Identifiers P / R | 66.7% / 50.0% | 0.0% / 0.0% | – / – |
| Routing | 50.0% | 50.0% | 100.0% |
| Must-review R / P | 100.0% / 66.7% | 50.0% / 100.0% | 100.0% / 50.0% |
| Sent to review | 75.0% | 50.0% | 100.0% |
| Summary faithful / complete | 4.33 / 3.67 | 5.00 / 5.00 | 3.00 / 4.00 |

Groups under 30 messages are indicative only: one message moves their accuracy by several points.

## Intents

| Intent | Labelled | Predicted | Correct | Precision | Recall | F1 |
| --- | --- | --- | --- | --- | --- | --- |
| `billing_question` | 1 | 2 | 1 | 50.0% | 100.0% | 0.667 |
| `technical_fault` | 2 | 1 | 1 | 100.0% | 50.0% | 0.667 |
| `tariff_change` | 1 | 1 | 1 | 100.0% | 100.0% | 1.000 |
| `cancellation` | 1 | 0 | 0 | – | 0.0% | 0.000 |
| `complaint` | 2 | 2 | 1 | 50.0% | 50.0% | 0.500 |
| `other` | 1 | 0 | 0 | – | 0.0% | 0.000 |

### Confusion matrix

Rows are the labelled intents, columns the predicted ones; `invalid` collects invalid outputs and errors.

| label \ predicted | `billing_question` | `technical_fault` | `tariff_change` | `cancellation` | `complaint` | `other` | `invalid` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `billing_question` | **1** | 0 | 0 | 0 | 0 | 0 | 0 |
| `technical_fault` | 0 | **1** | 0 | 0 | 1 | 0 | 0 |
| `tariff_change` | 0 | 0 | **1** | 0 | 0 | 0 | 0 |
| `cancellation` | 0 | 0 | 0 | **0** | 0 | 0 | 1 |
| `complaint` | 1 | 0 | 0 | 0 | **1** | 0 | 0 |
| `other` | 0 | 0 | 0 | 0 | 0 | **0** | 1 |

## Routing

Each message is masked, enriched against the mock CRM (enrich.v1) with the classified area and service type, and routed (route.v2), as the pipeline would. No model is called. Invalid outputs and errors go to `general` and to review.

| Must-review | Value |
| --- | --- |
| Labelled must-review | 5 |
| Sent to review | 6 (75.0% of all messages) |
| Caught (true positives) | 4 |
| Reviewed but not labelled (false positives) | 2 |
| Missed (false negatives) | 1 |
| Recall / precision | 80.0% / 66.7% |

### Reason codes

Messages each code fired on; a message can have several.

| Code | Messages |
| --- | --- |
| `processing_failed` | 0 |
| `invalid_output` | 1 |
| `classification_error` | 1 |
| `cancellation` | 0 |
| `complaint` | 2 |
| `low_confidence` | 1 |
| `customer_not_found` | 1 |
| `customer_ambiguous` | 0 |
| `customer_unidentified` | 0 |
| `crm_mismatch_unmatched_key` | 0 |
| `crm_mismatch_service_type` | 1 |
| `investigation_inconclusive` | 0 |

### Labelled reasons

Whether each labelled review reason got its own code. A message caught by another code still counts for must-review recall.

| Labelled reason | Caught by | Labelled | Caught | Rate |
| --- | --- | --- | --- | --- |
| `cancellation` | `cancellation` | 1 | 0 | 0.0% |
| `complaint` | `complaint` | 2 | 1 | 50.0% |
| `unclear` | `low_confidence` | 2 | 1 | 50.0% |

### Missed must-review messages

| Message | Lang | Label | Labelled reasons | Routed to | Confidence |
| --- | --- | --- | --- | --- | --- |
| m3 | sk | `billing_question` | `unclear` | `billing` | 0.70 |

## Confidence

Mean confidence: 0.73 when the intent was right, 0.89 when it was wrong.

| Confidence | Messages | Intent accuracy |
| --- | --- | --- |
| < 0.5 | 1 | 100.0% |
| 0.5–0.8 | 1 | 100.0% |
| 0.8–0.9 | 2 | 50.0% |
| ≥ 0.9 | 2 | 50.0% |

## Worst errors

Wrong intents, most confident first (2 of 2).

| Message | Lang | Label | Predicted | Confidence | Summary |
| --- | --- | --- | --- | --- | --- |
| m7 | cs | `technical_fault` | `complaint` | 0.92 | Summary for complaint. |
| m2 | cs | `complaint` | `billing_question` | 0.85 | Summary for billing_question. |

## Summaries

Summaries graded by the judge: 5. Valid outputs not graded (judge output invalid or failed): 1.

## Cost and latency

|  | Classifier | Judge | Total |
| --- | --- | --- | --- |
| Cost | $0.0450 | $0.0012 | $0.0462 |
| Input tokens | 700 | 1,800 |  |
| Cache reads | 7,000 | 0 |  |
| Cache writes | 0 | 0 |  |
| Output tokens | 350 | 240 |  |

Cost per message: $0.0058. Calls served by a model without a known price, not in the totals: 1.

Classifier latency: p50 2.2 s, p95 4.0 s, max 4.0 s.
