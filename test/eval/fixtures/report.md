# Evaluation 20261119-120000-full-claude-opus-5-5-classify.v1

| Setting | Value |
| --- | --- |
| Set | full (8 messages) |
| Classifier | claude-opus-5-5, effort low, prompt classify.v1 |
| Summary judge | claude-haiku-5-5, effort low, prompt summary-judge.v1 |
| Masking | none (raw text sent to the model) |
| Dataset | eval/data/dataset.jsonl (sha256 f4e50c3762ff) |
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
