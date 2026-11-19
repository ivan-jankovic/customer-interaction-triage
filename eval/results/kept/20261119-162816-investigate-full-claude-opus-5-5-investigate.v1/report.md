# Investigation evaluation 20261119-162816-investigate-full-claude-opus-5-5-investigate.v1

| Setting | Value |
| --- | --- |
| Set | full (17 labelled technical faults) |
| Agent | claude-opus-5-5, effort low, prompt investigate.v1, investigate.v1, at most 6 turns |
| Input | classify run 20261119-010458-full-claude-opus-5-5-classify.v2 (classify.v2) |
| Masking and enrichment | mask.v1, enrich.v1, CRM seed sha256 97503b40f736 |
| Dataset | eval/data/dataset.jsonl (sha256 94ee3b2f479d) |
| Code | 57a954f0aa11 |
| Started | 2026-11-19T16:28:16.062Z |
| Complete | yes |

The labels are the causes designed into the mock CRM (`expected_cause` in the seed). The scoring is deterministic: `npm run eval:report -- 20261119-162816-investigate-full-claude-opus-5-5-investigate.v1` recomputes this report from the stored outputs.

With 17 faults, and one or two examples of some causes, the per-cause and per-language numbers are indicative only.

## Overall

| Metric | Value |
| --- | --- |
| Faults | 17 |
| Investigated | 17 |
| Cause accuracy | 94.1% |
| Sent to review by the investigation | 47.1% |
| Outcomes | valid 17, step_limit 0, invalid 0, error 0 |
| Turns per investigation | mean 2.00, max 3, step-limit hits 0 |
| Tool calls per investigation | mean 1.88, max 4, errors 0 |
| Tool calls by tool | check_outages 17, get_line_status 9, get_recent_tickets 6 |
| Cost | $0.3556 total, $0.0209 per fault |
| Latency | mean 6.2 s, max 11.2 s |

## Per cause

| Cause | Labelled | Predicted | Precision | Recall |
| --- | --- | --- | --- | --- |
| area_outage | 8 | 8 | 100.0% | 100.0% |
| line_fault | 1 | 1 | 100.0% | 100.0% |
| customer_equipment | 0 | 0 | – | – |
| service_inactive | 1 | 0 | – | 0.0% |
| inconclusive | 7 | 8 | 87.5% | 100.0% |

## Confusion matrix

Rows: designed cause. Columns: the agent's answer.

| designed \ answer | area_outage | line_fault | customer_equipment | service_inactive | inconclusive | no answer | not investigated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| area_outage | 8 | 0 | 0 | 0 | 0 | 0 | 0 |
| line_fault | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| customer_equipment | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| service_inactive | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| inconclusive | 0 | 0 | 0 | 0 | 7 | 0 | 0 |

## Per language

| Language | Faults | Cause accuracy |
| --- | --- | --- |
| cs | 10 | 90.0% |
| sk | 4 | 100.0% |
| en | 3 | 100.0% |

## Per message

| Message | Lang | Designed | Answer | Confidence | Outcome | Review | Turns | Tools | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| msg-007 | en | inconclusive | inconclusive | 0.20 | valid | yes | 1 | – | $0.0147 |
| msg-011 | cs | area_outage | area_outage | 0.70 | valid | no | 2 | check_outages, get_line_status, get_recent_tickets | $0.0374 |
| msg-012 | sk | area_outage | area_outage | 0.90 | valid | no | 2 | check_outages, get_line_status | $0.0296 |
| msg-017 | sk | inconclusive | inconclusive | 0.30 | valid | yes | 2 | check_outages | $0.0205 |
| msg-018 | cs | area_outage | area_outage | 0.93 | valid | no | 2 | get_line_status, check_outages, get_recent_tickets | $0.0224 |
| msg-021 | cs | inconclusive | inconclusive | 0.35 | valid | yes | 2 | check_outages | $0.0152 |
| msg-029 | cs | area_outage | area_outage | 0.75 | valid | no | 2 | check_outages | $0.0153 |
| msg-036 | cs | inconclusive | inconclusive | 0.30 | valid | yes | 2 | check_outages | $0.0140 |
| msg-037 | cs | area_outage | area_outage | 0.92 | valid | no | 2 | check_outages, get_line_status, get_recent_tickets | $0.0233 |
| msg-051 | sk | area_outage | area_outage | 0.95 | valid | no | 2 | check_outages, get_line_status, get_recent_tickets | $0.0195 |
| msg-056 | cs | area_outage | area_outage | 0.70 | valid | no | 2 | check_outages | $0.0179 |
| msg-063 | cs | inconclusive | inconclusive | 0.40 | valid | yes | 2 | check_outages | $0.0149 |
| msg-069 | cs | service_inactive | inconclusive ✗ | 0.30 | valid | yes | 3 | get_line_status, get_line_status, check_outages, check_outages | $0.0381 |
| msg-071 | sk | line_fault | line_fault | 0.75 | valid | no | 2 | get_line_status, check_outages, get_recent_tickets | $0.0232 |
| msg-078 | cs | inconclusive | inconclusive | 0.30 | valid | yes | 2 | check_outages | $0.0126 |
| msg-079 | en | inconclusive | inconclusive | 0.20 | valid | yes | 2 | check_outages | $0.0117 |
| msg-084 | en | area_outage | area_outage | 0.70 | valid | no | 2 | check_outages, get_line_status, get_recent_tickets | $0.0256 |
