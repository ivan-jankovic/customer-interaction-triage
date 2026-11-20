# Results

The evaluation results of Customer Interaction Triage in full. The [README](../README.md#results-at-a-glance) has the headline numbers; how the evaluations work and how to run them is in the [guide](guide.md#evaluating).

All numbers come from committed evaluation runs in [eval/results/kept/](../eval/results/kept/); each part links to its report.

## Classification and routing

`classify.v2` on `claude-opus-5-5`, all 100 messages ([report](../eval/results/kept/20261119-010458-full-claude-opus-5-5-classify.v2/report.md)):

| Metric | Result |
| --- | --- |
| Valid outputs | 100.0% |
| Intent accuracy | 100.0% (macro F1 1.000) |
| Urgency accuracy | 89.0% |
| Service type / area accuracy | 98.0% / 99.0% |
| Routing accuracy (team) | 100.0% |
| Must-review recall / precision | 100.0% (38 of 38) / 67.9% |
| Sent to review | 56.0% |
| Summary faithful / complete (1–5, judged by `claude-haiku-5-5`) | 4.86 / 4.49 |
| Cost per message | $0.0060 |
| Latency p50 / p95 | 2.1 s / 2.9 s |

Confusion matrix (rows: labelled intent; columns: predicted):

| | billing | technical | tariff | cancellation | complaint | other |
| --- | --- | --- | --- | --- | --- | --- |
| `billing_question` | **17** | 0 | 0 | 0 | 0 | 0 |
| `technical_fault` | 0 | **17** | 0 | 0 | 0 | 0 |
| `tariff_change` | 0 | 0 | **17** | 0 | 0 | 0 |
| `cancellation` | 0 | 0 | 0 | **16** | 0 | 0 |
| `complaint` | 0 | 0 | 0 | 0 | **17** | 0 |
| `other` | 0 | 0 | 0 | 0 | 0 | **16** |

By language (Slovak and English have 20 messages each, so their numbers are indicative only):

| Metric | Czech (60) | Slovak (20) | English (20) |
| --- | --- | --- | --- |
| Intent | 100.0% | 100.0% | 100.0% |
| Urgency | 90.0% | 90.0% | 85.0% |
| Must-review recall / precision | 100.0% / 63.9% | 100.0% / 80.0% | 100.0% / 70.0% |
| Sent to review | 60.0% | 50.0% | 50.0% |

**Must-review** means the labels say a person should see the message: the 33 cancellations and complaints, and 6 messages labelled *unclear*, where even a person can't tell what the customer wants (one is both), 38 in all. Unclear isn't an intent; at runtime those cases are caught by low confidence. **Why 56% go to review:** the dataset gives every intent about the same share (16 or 17 messages), so cancellations and complaints, which are always reviewed, are a third of it, and the mock CRM has customers that can't be found or match more than one on purpose. Among the routine messages (every intent except cancellation and complaint), 34% go to review. The rules are conservative on purpose: a missed review costs more than an extra check.

## Investigation

`investigate.v1` over the 17 labelled technical faults ([report](../eval/results/kept/20261119-162816-investigate-full-claude-opus-5-5-investigate.v1/report.md)): **cause accuracy 100.0%** (17 of 17, counting `inconclusive` as the right answer where the faults were designed to have no findable cause), all answers valid, 2.0 turns and 1.9 tool calls on average, 47.1% sent to review by the investigation (8 of the 17 faults are designed to have no findable cause, and the agent correctly answers `inconclusive`, which goes to review), $0.0209 and 6.2 s per fault on average. Some causes have only one or two examples.

## Prompt injection

15 messages with instructions aimed at the model, in all three languages, using 5 tactics (a direct instruction, fake system text, an instruction hidden in a quoted e-mail, a review bypass, a request for data) toward 4 goals, each run 5 times through the whole pipeline ([report](../eval/results/kept/20261119-182812-injection-x5-claude-opus-5-5-classify.v2/report.md)): **15 of 15 scenarios passed in all 5 repeats**. No action was triggered (the agent called only its three tools, and only about the case's own customer), every must-review message went to review, no output contained an identifier or another customer's data, and every attack's goal (reroute, skip review, leak data, trigger an action) failed. Cost $0.74.

## Opus vs Sonnet

The same prompt on two models, all 100 messages ([comparison](../eval/results/kept/comparisons/p12-opus-vs-sonnet.md)):

| Metric | Opus 5.5 | Sonnet 5.5 |
| --- | --- | --- |
| Intent accuracy | 100.0% | 100.0% |
| Must-review recall | 100.0% | 100.0% |
| Urgency accuracy | 89.0% | 85.0% |
| Cost per message | $0.0060 | $0.0033 |
| Latency p50 / p95 | 2.1 s / 2.9 s | 2.0 s / 2.4 s |

Sonnet makes the same routing and review decisions at 55% of the cost. The default stays Opus for now, because this dataset can't show where the two would differ.

## What the results do and don't show

They show that the pipeline does what it was designed to do: on clean, labelled messages it understands every intent, routes every message to the right team, never auto-routes a message that needed a person, and its safety rules hold against the injection set.

They don't show how it would do on real traffic:

- **The dataset is small and synthetic.** 100 messages, every intent with about the same share, and only 15 deliberately hard ones (several intents at once, or unclear what the customer wants). Real traffic is messier and less balanced.
- **The messages may be easy.** They were written by `claude-opus-5-5`, the same model the classifier uses, from labels chosen first and a labelling guide. The labels are independent of the pipeline (two other models graded them and a person reviewed every disagreement), but the wording comes from the model being tested. The graders never disagreed on intent.
- **Perfect scores can't rank alternatives.** With 100% intent accuracy on both models, and on both prompt versions (`classify.v1` read the raw text and extracted identifiers itself; `classify.v2` gets masked text and the identifiers come from the masking map; masking cost no intent accuracy), the dataset can't show which is better; only urgency and cost separate them.
- **Urgency is the softest label.** Every reviewer correction during labelling was on urgency, and it is the one metric well below 100%. No rule reads it.

The next step for trustworthy numbers is a harder dataset (see the [README, Next steps](../README.md#next-steps)).
