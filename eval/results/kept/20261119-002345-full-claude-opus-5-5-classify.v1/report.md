# Evaluation 20261119-002345-full-claude-opus-5-5-classify.v1

| Setting | Value |
| --- | --- |
| Set | full (100 messages) |
| Classifier | claude-opus-5-5, effort low, prompt classify.v1 |
| Summary judge | claude-haiku-5-5, effort low, prompt summary-judge.v1 |
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
