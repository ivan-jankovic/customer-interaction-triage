# Comparison: 20261119-120000-full-claude-opus-5-5-classify.v1 → 20261119-130000-full-claude-opus-5-5-classify.v2

| Setting | A | B |
| --- | --- | --- |
| Run | 20261119-120000-full-claude-opus-5-5-classify.v1 | 20261119-130000-full-claude-opus-5-5-classify.v2 |
| Set | full (n=8) | full (n=8) |
| Classifier | claude-opus-5-5, effort low | claude-opus-5-5, effort low |
| Prompt | classify.v1 | classify.v2 |
| Summary judge | claude-haiku-5-5, summary-judge.v1 | claude-haiku-5-5, summary-judge.v1 |
| Masking | none | mask.v1 |
| Dataset | f4e50c3762ff | f4e50c3762ff |

## Headline metrics

| Metric | A | B | Change |
| --- | --- | --- | --- |
| Valid outputs | 75.0% | 75.0% | ±0.0 pp |
| Intent accuracy | 50.0% | 62.5% | +12.5 pp |
| Intent macro F1 | 0.47 | 0.56 | +0.08 |
| Urgency accuracy | 50.0% | 50.0% | ±0.0 pp |
| Language accuracy | 62.5% | 62.5% | ±0.0 pp |
| Service type accuracy | 62.5% | 62.5% | ±0.0 pp |
| Area accuracy | 62.5% | 62.5% | ±0.0 pp |
| Identifiers precision | 50.0% | 50.0% | ±0.0 pp |
| Identifiers recall | 40.0% | 40.0% | ±0.0 pp |
| Identifier lists exact | 37.5% | 37.5% | ±0.0 pp |
| Summary faithful (1–5) | 4.20 | 4.20 | ±0.00 |
| Summary complete (1–5) | 4.00 | 4.00 | ±0.00 |
| Summaries with personal data | 20.0% | 20.0% | ±0.0 pp |
| Mean confidence, right intents | 0.73 | 0.77 | +0.04 |
| Cost per message | $0.0058 | $0.0058 | ±$0.0000 |
| Latency p50 | 2.2 s | 2.2 s | ±0.0 s |
| Latency p95 | 4.0 s | 4.0 s | ±0.0 s |

Summaries graded: 5 vs 5. Invalid outputs: 1 vs 1; errors: 1 vs 1; fallbacks: 1 vs 1.

## By language

| Language | Intent A | Intent B | Change | Urgency A | Urgency B | Change |
| --- | --- | --- | --- | --- | --- | --- |
| cs (n=4, indicative) | 50.0% | 75.0% | +25.0 pp | 75.0% | 75.0% | ±0.0 pp |
| sk (n=2, indicative) | 50.0% | 50.0% | ±0.0 pp | 0.0% | 0.0% | ±0.0 pp |
| en (n=2, indicative) | 50.0% | 50.0% | ±0.0 pp | 50.0% | 50.0% | ±0.0 pp |

pp = percentage points. A change of one message is 1 pp on 100 messages and 5 pp on 20.
