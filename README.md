# Customer Interaction Triage

A system that does the first pass over customer messages for **Merelo**, a fictional Czech internet and mobile provider. E-mails, chats and call transcripts arrive in Czech, Slovak or English; the system works out what each one is about, finds the customer, routes the case to the right team, and sends it to a person whenever it is unsure or the case should not be decided by a machine. Only synthetic data is used.

It is built spec-first: what and why in [specs/mission.md](specs/mission.md), how in [specs/tech-stack.md](specs/tech-stack.md), the order of work in [specs/roadmap.md](specs/roadmap.md), and one folder per phase in [specs/phases/](specs/phases/) with the requirements, plan and validation of each step. How to run everything is in the [guide](docs/guide.md).

## What it does

1. **Intake:** an API receives a message, stores it (as an *interaction*) and queues it.
2. **Masking:** phone numbers, e-mail addresses, customer and contract numbers, birth numbers (the Czech and Slovak personal ID number) and bank accounts become typed placeholders before any model sees the text.
3. **Understanding:** one model call with structured output: an intent from a fixed list, urgency, service type, area, a short summary and a confidence.
4. **Enrichment:** the customer is looked up in a mock CRM by the identifiers that were masked (their values come from the stored mapping, not from the model), and a mock list of outages is checked for the area.
5. **Investigation:** for technical faults only, a small agent with three read-only tools looks for the likely cause and returns it with a confidence and evidence.
6. **Routing:** rules in code choose the team and decide whether a person must review the case.
7. **Case record:** one case per message, with a decision log of what each step read, produced and which version decided.
8. **Review:** people confirm or correct the cases that need review, in a terminal or on a small web page.

What it deliberately doesn't do: talk to customers, take actions on its own (the agent only reads and reports), or use real customer data.

## Architecture

```mermaid
flowchart LR
  client["Sender<br/>(dataset loader, curl)"] -->|"POST /interactions<br/>x-api-key"| api
  subgraph app["Node.js app (Fastify)"]
    api["Intake API"]
    web["Review web page<br/>/review"]
  end
  api -->|store| pg[("PostgreSQL<br/>messages, cases, logs,<br/>reviews, mock CRM")]
  api -->|"enqueue job (ID only)"| redis[("Redis<br/>BullMQ queue")]
  redis --> worker["Worker<br/>runs the pipeline"]
  worker <-->|read / write| pg
  worker -->|"masked text only"| llm["Anthropic API<br/>(Claude)"]
  worker -. "sweep: messages with no case" .-> pg
  reviewer["Reviewer"] --> web
  reviewer --> cli["Review CLI"]
  web <--> pg
  cli <--> pg
```

Everything runs locally with Docker Compose: PostgreSQL, Redis, the app and, when asked for (`docker compose --profile worker up`), the worker. The worker is opt-in because every message it processes is a paid model call. A queue job holds only the message's ID, so Redis never sees message text. If saving and queueing get out of step (Redis down, a crash between the two), the worker's sweep queues every message that has no case yet.

## The pipeline

```mermaid
flowchart LR
  intake[Intake] --> mask[Mask]
  mask --> classify["Classify 🤖"]
  classify --> enrich[Enrich]
  enrich --> tf{"technical<br/>fault?"}
  tf -- yes --> investigate["Investigate 🤖<br/>agent, ≤ 6 turns"]
  tf -- no --> route
  investigate --> route[Route]
  route --> record["Case + decision log"]
  record --> review{"needs<br/>review?"}
  review -- yes --> queue[Review queue]
  review -- no --> team[Team's queue]
```

🤖 marks the two steps that call a model. Everything else is plain code, free to run and covered by unit tests.

| Step | What it does | Stores |
| --- | --- | --- |
| Mask | Rule-based: finds identifiers by format and replaces them with `[PHONE_1]`, `[CUSTOMER_NUMBER_1]`, … | masked text, `masked_identifiers` |
| Classify | One call to Claude with a JSON Schema; the output is validated with Ajv. Invalid output is kept and the case goes to review. | `classifications` (every attempt) |
| Enrich | CRM lookup by the masked identifiers' values (`found`, `not_found`, `ambiguous`, `no_identifiers`); outages in the area at the message's time. | `enrichments` |
| Investigate | Technical faults only: a bounded agent loop with `check_outages`, `get_line_status` and `get_recent_tickets`, ending in a validated likely cause with evidence. An answer that is invalid, hits the step limit, finds no cause or is under 0.7 confident sends the case to review. | `investigations` (every tool call) |
| Route | Team by intent; review when any rule fires, with every reason code kept. | `cases`, `decision_log` |
| Review | Confirm or correct (intent and team, with a note), or skip for now, which stores nothing; unmasking the raw text needs a reason and is logged. | `reviews`, `unmask_log` |

Each step stores what it did, and a retried job reuses what earlier attempts stored, so a retry never pays twice for a model call. A job is tried 5 times with growing pauses; if it still fails, the message gets a case in `general` with the reason `processing_failed`, so every message ends as exactly one case and the sweep stops picking it up.

## Data model

Every message is an `interactions` row. The steps' results hang off it, and the case ties them together:

```mermaid
erDiagram
  interactions ||--o{ masked_identifiers : "masked into"
  interactions ||--o{ classifications : "attempts"
  interactions ||--o{ enrichments : "attempts"
  interactions ||--o{ investigations : "attempts"
  interactions ||--o| cases : "ends as one"
  cases ||--|{ decision_log : "one entry per step"
  cases ||--o| reviews : "at most one"
  cases ||--o{ unmask_log : "every raw-text view"
```

- **Attempts are rows, never updates.** Every classification, enrichment and investigation attempt is a new row, including invalid ones and errors. A case names the attempts it used.
- **One case per message**, written once, with its decision log in the same transaction. The log holds IDs, versions, outcomes and placeholders only: no message text and no identifier values.
- **A review never changes the case.** A correction is a row of its own with the intent and team that should have been chosen.

The enrichment and the investigation read a **mock CRM** (customers, services, tickets, line status and outages), generated from the dataset so it matches the messages. Every table with its key columns, and the mock CRM, are in the [guide, Data model](docs/guide.md#data-model); every column is in [tech-stack.md](specs/tech-stack.md#data-model-initial).

## Key decisions

### A workflow, with one bounded agent

**Decision:** the pipeline is a fixed sequence of steps. The only agent investigates technical faults, with three read-only tools, at most 6 model turns and 12 tool calls, and a validated answer.
**Alternative:** one agent that reads the message and decides everything with tools.
**Why:** most of the work is the same every time, and a fixed sequence is cheaper, testable and predictable. Open-ended searching helps in one place: working out why a line is down. Even there the agent decides nothing; an inconclusive answer sends the case to review. ([P10](specs/phases/011-p10-investigating-agent/requirements.md))

### Decisions in code, not in the prompt

**Decision:** routing and review are deterministic rules in [src/pipeline/route.ts](src/pipeline/route.ts), versioned and unit-tested. The model only reads text.
**Alternative:** ask the model for the team and whether a person should look at the case.
**Why:** rules can be tested, explained and audited: every case's decision log names the rules that fired. A prompt instruction can be talked out of by the message itself. Cancellations and complaints always go to a person, whatever the model's confidence. The other review reasons: invalid output or a failed call, confidence below 0.7, a customer not found or matching more than one customer, a technical fault with no account identifier, a mismatch with the CRM (one identifier matched the customer but another matched no one, or the customer has no service of the type the message is about), an inconclusive investigation, an identifier in a model's output, and a message whose processing failed. Every reason that applies is kept. ([P07](specs/phases/008-p07-routing-rules-decision-log/requirements.md))

### Structured output, validated before use

**Decision:** the classifier answers in a JSON Schema through the API's structured output, and every answer is validated with Ajv. Invalid output is stored and the case goes to review.
**Alternative:** free-text answers parsed with patterns, or trusting the structured output as it comes.
**Why:** a schema makes the answer usable by code; validating it anyway means a bad answer can never become a decision, only a review. ([P03](specs/phases/004-p03-understanding-structured-output/requirements.md))

### Masking before the model

**Decision:** identifiers are replaced by typed, numbered placeholders by rules, before any model call. The mapping stays in PostgreSQL and is what the CRM lookup uses, so the model never needs to extract identifiers.
**Alternative:** send the raw text, or mask with a model.
**Why:** a model can't leak what it never saw, and a rule-based masker is deterministic and testable. It finds values by format, not by checksum, because real input has typos. Personal names and street addresses are **not** masked: rules can't find them reliably, and nothing looks them up. ([P05](specs/phases/006-p05-masking/requirements.md))

### Queue consistency: a sweep, not an outbox

**Decision:** intake saves the message, then tries to queue it with a 1-second timeout. Every 30 seconds the worker queues every message that has no case and is more than a minute old.
**Alternative:** an outbox table written in the same transaction as the message.
**Why:** an outbox needs its own poller anyway, and it can't recover a job that was handed to Redis and then lost there. The sweep reads the one fact that matters, "no case yet", from PostgreSQL. Jobs are idempotent, so a message queued twice is processed once. ([P08](specs/phases/009-p08-asynchronous-processing/requirements.md))

### Untrusted input: layered defences

**Decision:** five layers against instructions hidden in messages: the prompt marks the message as data; output is validated (an extra field like `"skip_review": true` makes it invalid); decisions are in code; the agent's tools are read-only and only accept the case's own customer; and an identifier value (not a placeholder) in any model output sends the case to review: no model sees the values, so one in its output was guessed or slipped past the masker.
**Alternative:** rely on a well-written prompt.
**Why:** only the first layer depends on the model. The others hold even when the model is fooled, and tests with a mocked model that obeys the injection show exactly what they hold. ([P11](specs/phases/012-p11-prompt-injection-scenarios/requirements.md))

### A labelled dataset the pipeline can't grade itself on

**Decision:** 100 messages with labels chosen first; a model writes a message for each label set; two other models (`claude-sonnet-5-5` and `claude-haiku-5-5`) label every message without seeing the chosen labels; a person reviews every disagreement plus a random sample of 10 where all agree.
**Alternative:** a public dataset, or labelling generated messages with the pipeline's own prompts.
**Why:** there is no public dataset of Czech and Slovak telecom messages with these labels, and labels produced by the pipeline would only measure agreement with itself. ([P00](specs/phases/001-p00-intents-schemas-labelled-dataset/requirements.md), [dataset README](eval/data/README.md))

### Evaluation in CI with a threshold

**Decision:** an 18-message subset runs with the real model on pull requests that change what the model sees or how it is scored (the prompts and LLM client, the pipeline, the taxonomy, the config, the evaluation code, the dependencies), and fails below 16 of 18 intents right or if any must-review message would be auto-routed. It uses a separate API key with its own spend limit.
**Alternative:** evaluate only by hand, or the full set on every pull request.
**Why:** a prompt or model change that hurts quality should fail like a broken test, at about $0.12 a run instead of $0.60 for the full set. ([P12](specs/phases/013-p12-eval-in-ci-comparisons/requirements.md))

### Review: final, masked by default, every unmask logged

**Decision:** one review per case, never edited. Reviewers see the masked text; the raw text needs a reason and is logged before it is shown. The web page reuses the CLI's logic. It is protected by one access key shared by all reviewers (not a per-person login), a signed session cookie and CSRF tokens.
**Alternative:** editable cases, or showing the raw text by default.
**Why:** a case and its review stay an audit trail of who decided what and why. Masking protects the model boundary; logging makes staff access to personal data visible. ([P09](specs/phases/010-p09-review-queue-cli/requirements.md), [P13](specs/phases/014-p13-review-web-page/requirements.md))

## Results

All numbers come from committed evaluation runs in [eval/results/kept/](eval/results/kept/); each part links to its report.

### Classification and routing

`classify.v2` on `claude-opus-5-5`, all 100 messages ([report](eval/results/kept/20261119-010458-full-claude-opus-5-5-classify.v2/report.md)):

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

### Investigation

`investigate.v1` over the 17 labelled technical faults ([report](eval/results/kept/20261119-162816-investigate-full-claude-opus-5-5-investigate.v1/report.md)): **cause accuracy 100.0%** (17 of 17, counting `inconclusive` as the right answer where the faults were designed to have no findable cause), all answers valid, 2.0 turns and 1.9 tool calls on average, 47.1% sent to review by the investigation (8 of the 17 faults are designed to have no findable cause, and the agent correctly answers `inconclusive`, which goes to review), $0.0209 and 6.2 s per fault on average. Some causes have only one or two examples.

### Prompt injection

15 messages with instructions aimed at the model, in all three languages, using 5 tactics (a direct instruction, fake system text, an instruction hidden in a quoted e-mail, a review bypass, a request for data) toward 4 goals, each run 5 times through the whole pipeline ([report](eval/results/kept/20261119-182812-injection-x5-claude-opus-5-5-classify.v2/report.md)): **15 of 15 scenarios passed in all 5 repeats**. No action was triggered (the agent called only its three tools, and only about the case's own customer), every must-review message went to review, no output contained an identifier or another customer's data, and every attack's goal (reroute, skip review, leak data, trigger an action) failed. Cost $0.74.

### Opus vs Sonnet

The same prompt on two models, all 100 messages ([comparison](eval/results/kept/comparisons/p12-opus-vs-sonnet.md)):

| Metric | Opus 5.5 | Sonnet 5.5 |
| --- | --- | --- |
| Intent accuracy | 100.0% | 100.0% |
| Must-review recall | 100.0% | 100.0% |
| Urgency accuracy | 89.0% | 85.0% |
| Cost per message | $0.0060 | $0.0033 |
| Latency p50 / p95 | 2.1 s / 2.9 s | 2.0 s / 2.4 s |

Sonnet makes the same routing and review decisions at 55% of the cost. The default stays Opus for now, because this dataset can't show where the two would differ.

### What the results do and don't show

They show that the pipeline does what it was designed to do: on clean, labelled messages it understands every intent, routes every message to the right team, never auto-routes a message that needed a person, and its safety rules hold against the injection set.

They don't show how it would do on real traffic:

- **The dataset is small and synthetic.** 100 messages, every intent with about the same share, and only 15 deliberately hard ones (several intents at once, or unclear what the customer wants). Real traffic is messier and less balanced.
- **The messages may be easy.** They were written by `claude-opus-5-5`, the same model the classifier uses, from labels chosen first and a labelling guide. The labels are independent of the pipeline (two other models graded them and a person reviewed every disagreement), but the wording comes from the model being tested. The graders never disagreed on intent.
- **Perfect scores can't rank alternatives.** With 100% intent accuracy on both models, and on both prompt versions (`classify.v1` read the raw text and extracted identifiers itself; `classify.v2` gets masked text and the identifiers come from the masking map; masking cost no intent accuracy), the dataset can't show which is better; only urgency and cost separate them.
- **Urgency is the softest label.** Every reviewer correction during labelling was on urgency, and it is the one metric well below 100%. No rule reads it.

The next step for trustworthy numbers is a harder dataset (see Next steps).

## Review page

The queue, with the CLI's filters and the cases waiting for a person:

![The review queue: five cases waiting, with filters and reason codes](docs/images/review-queue.png)

A case: the decision and why, the classification and the masked message, followed by the evidence, the decision log and the forms to confirm, correct, skip or unmask:

![The top of a case page: decision, classification and the masked message](docs/images/review-case.png)

For a technical fault, what the agent found and which tools it called:

![The investigation section: likely cause area_outage with evidence and three tool calls](docs/images/review-investigation.png)

The decisions made so far, with corrections next to what the case said:

![The reviewed cases list: two confirmations and two corrections](docs/images/review-reviewed.png)

## Limitations

- **Results on a small, synthetic, possibly easy dataset** (see above).
- **Names and street addresses are not masked** and reach the model. The summary rules ask the model not to repeat them, and the evaluation's judge flags any summary that does.
- **Identifier formats are Czech and Slovak only.**
- **Two known injection limits:** a confidently wrong intent (a cancellation read as a billing question at confidence 0.7 or more is auto-routed), and a misleading summary without identifiers. Both are pinned down by tests that show the behaviour (`KNOWN LIMIT` in [the security tests](test/security/fooled-model.test.ts)).
- **Review rules are conservative and untuned:** 56% of the dataset goes to review. Corrections are stored but not used yet.
- **The reviewer is not authenticated.** The handle is recorded, not verified, and the web page's key is shared. There is no login rate limit, because it only runs locally.
- **No hosted deployment.** Everything runs on one machine with Docker Compose.
- **The default model is the more expensive one,** although Sonnet matched it on this dataset; switching is a separate decision.

## Next steps

From the [roadmap](specs/roadmap.md), all optional:

- **Transcription (P15):** speech-to-text for synthetic call recordings at the start of the pipeline, and its effect on classification.
- **MCP server (P16):** the read-only CRM and outage tools for any MCP client.
- **Confidence gate comparison (P17):** self-reported confidence vs. self-consistency vs. probabilities over the intents vs. a classical TF-IDF baseline, compared on calibration and review recall.
- **Ideas for later** (roadmap): reply drafts for simple cases, sent only after review; learning from review corrections; a queue dashboard.
- **A harder dataset:** more ambiguous and messier messages from a new generation prompt, as the [dataset README](eval/data/README.md) suggests, so the evaluation can tell alternatives apart.

## Quick start

Requirements: Node.js 24 and Docker with Compose.

```sh
npm ci
cp .env.example .env              # set INTAKE_API_KEY (openssl rand -hex 32); ANTHROPIC_API_KEY for anything that calls a model
docker compose up -d --wait       # PostgreSQL, Redis, migrations and the intake API on http://localhost:3000
npm run crm:seed                  # the mock CRM and outages
npm run dataset:load              # the 100 dataset messages, stored and queued (free)
npm test                          # unit tests: no Docker, no network, no model calls
```

Nothing is classified until a worker runs, and that costs money: about $0.006 per message, plus about $0.02 per technical fault for the investigation. An evaluation of the full set costs about $0.60, the CI subset about $0.12. The [guide](docs/guide.md) explains the worker, each step's command, the review CLI and web page, the evaluations and the checks.
