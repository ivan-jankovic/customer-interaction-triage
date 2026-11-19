# Comparison: 20261119-010458-full-claude-opus-5-5-classify.v2 → 20261119-232004-full-claude-sonnet-5-5-classify.v2

| Setting | A | B |
| --- | --- | --- |
| Run | 20261119-010458-full-claude-opus-5-5-classify.v2 | 20261119-232004-full-claude-sonnet-5-5-classify.v2 |
| Set | full (n=100) | full (n=100) |
| Classifier | claude-opus-5-5, effort low | claude-sonnet-5-5, effort low |
| Prompt | classify.v2 | classify.v2 |
| Summary judge | claude-haiku-5-5, summary-judge.v1 | claude-haiku-5-5, summary-judge.v1 |
| Masking | mask.v1 | mask.v1 |
| Dataset | 94ee3b2f479d | 94ee3b2f479d |

## Headline metrics

| Metric | A | B | Change |
| --- | --- | --- | --- |
| Valid outputs | 100.0% | 100.0% | ±0.0 pp |
| Intent accuracy | 100.0% | 100.0% | ±0.0 pp |
| Intent macro F1 | 1.00 | 1.00 | ±0.00 |
| Urgency accuracy | 89.0% | 85.0% | −4.0 pp |
| Language accuracy | 100.0% | 100.0% | ±0.0 pp |
| Service type accuracy | 98.0% | 100.0% | +2.0 pp |
| Area accuracy | 99.0% | 100.0% | +1.0 pp |
| Identifiers precision | 100.0% | 100.0% | ±0.0 pp |
| Identifiers recall | 100.0% | 100.0% | ±0.0 pp |
| Identifier lists exact | 100.0% | 100.0% | ±0.0 pp |
| Summary faithful (1–5) | 4.86 | 4.88 | +0.02 |
| Summary complete (1–5) | 4.49 | 4.45 | −0.04 |
| Summaries with personal data | 0.0% | 0.0% | ±0.0 pp |
| Mean confidence, right intents | 0.86 | 0.88 | +0.02 |
| Cost per message | $0.0060 | $0.0033 | −$0.0027 |
| Latency p50 | 2.1 s | 2.0 s | −0.2 s |
| Latency p95 | 2.9 s | 2.4 s | −0.5 s |

Summaries graded: 100 vs 100. Invalid outputs: 0 vs 0; errors: 0 vs 0; fallbacks: 0 vs 0.

## Routing

| Metric | A | B | Change |
| --- | --- | --- | --- |
| Routing accuracy (team) | 100.0% | 100.0% | ±0.0 pp |
| Must-review recall | 100.0% | 100.0% | ±0.0 pp |
| Must-review precision | 67.9% | 67.9% | ±0.0 pp |
| Review rate | 56.0% | 56.0% | ±0.0 pp |

Must-review messages auto-routed: 0 of 38 vs 0 of 38. Router: route.v4 vs route.v4.

## Per intent

| Intent | F1 A | F1 B | Change |
| --- | --- | --- | --- |
| `billing_question` (n=17) | 1.00 | 1.00 | ±0.00 |
| `technical_fault` (n=17) | 1.00 | 1.00 | ±0.00 |
| `tariff_change` (n=17) | 1.00 | 1.00 | ±0.00 |
| `cancellation` (n=16) | 1.00 | 1.00 | ±0.00 |
| `complaint` (n=17) | 1.00 | 1.00 | ±0.00 |
| `other` (n=16) | 1.00 | 1.00 | ±0.00 |

## By language

| Language | Intent A | Intent B | Change | Urgency A | Urgency B | Change |
| --- | --- | --- | --- | --- | --- | --- |
| cs (n=60) | 100.0% | 100.0% | ±0.0 pp | 90.0% | 83.3% | −6.7 pp |
| sk (n=20, indicative) | 100.0% | 100.0% | ±0.0 pp | 90.0% | 90.0% | ±0.0 pp |
| en (n=20, indicative) | 100.0% | 100.0% | ±0.0 pp | 85.0% | 85.0% | ±0.0 pp |

pp = percentage points. A change of one message is 1 pp on 100 messages and 5 pp on 20.
