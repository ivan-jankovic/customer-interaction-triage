# Comparison: 20261119-002345-full-claude-opus-5-5-classify.v1 → 20261119-010458-full-claude-opus-5-5-classify.v2

| Setting | A | B |
| --- | --- | --- |
| Run | 20261119-002345-full-claude-opus-5-5-classify.v1 | 20261119-010458-full-claude-opus-5-5-classify.v2 |
| Set | full (n=100) | full (n=100) |
| Classifier | claude-opus-5-5, effort low | claude-opus-5-5, effort low |
| Prompt | classify.v1 | classify.v2 |
| Summary judge | claude-haiku-5-5, summary-judge.v1 | claude-haiku-5-5, summary-judge.v1 |
| Masking | none | mask.v1 |
| Dataset | 94ee3b2f479d | 94ee3b2f479d |

## Headline metrics

| Metric | A | B | Change |
| --- | --- | --- | --- |
| Valid outputs | 100.0% | 100.0% | ±0.0 pp |
| Intent accuracy | 100.0% | 100.0% | ±0.0 pp |
| Intent macro F1 | 1.00 | 1.00 | ±0.00 |
| Urgency accuracy | 89.0% | 89.0% | ±0.0 pp |
| Language accuracy | 100.0% | 100.0% | ±0.0 pp |
| Service type accuracy | 99.0% | 98.0% | −1.0 pp |
| Area accuracy | 99.0% | 99.0% | ±0.0 pp |
| Identifiers precision | 100.0% | 100.0% | ±0.0 pp |
| Identifiers recall | 100.0% | 100.0% | ±0.0 pp |
| Identifier lists exact | 100.0% | 100.0% | ±0.0 pp |
| Summary faithful (1–5) | 4.90 | 4.86 | −0.04 |
| Summary complete (1–5) | 4.41 | 4.49 | +0.08 |
| Summaries with personal data | 0.0% | 0.0% | ±0.0 pp |
| Mean confidence, right intents | 0.86 | 0.86 | −0.00 |
| Cost per message | $0.0067 | $0.0060 | −$0.0007 |
| Latency p50 | 2.2 s | 2.1 s | −0.0 s |
| Latency p95 | 3.1 s | 2.9 s | −0.1 s |

Summaries graded: 97 vs 100. Invalid outputs: 0 vs 0; errors: 0 vs 0; fallbacks: 0 vs 0.

## By language

| Language | Intent A | Intent B | Change | Urgency A | Urgency B | Change |
| --- | --- | --- | --- | --- | --- | --- |
| cs (n=60) | 100.0% | 100.0% | ±0.0 pp | 90.0% | 90.0% | ±0.0 pp |
| sk (n=20, indicative) | 100.0% | 100.0% | ±0.0 pp | 90.0% | 90.0% | ±0.0 pp |
| en (n=20, indicative) | 100.0% | 100.0% | ±0.0 pp | 85.0% | 85.0% | ±0.0 pp |

pp = percentage points. A change of one message is 1 pp on 100 messages and 5 pp on 20.
