# Mission

**Customer Interaction Triage** (`customer-interaction-triage`)

## What we are building

A system that does the **first pass over incoming customer messages** for a fictional Czech internet and mobile provider: it understands each message, finds the customer, routes the case to the right team, and sends it to a person whenever it is unsure or should not decide on its own.

Messages arrive as emails, chat logs and call transcripts, **mostly in Czech, some in English and Slovak**; these are the three supported languages.

## Why

In a contact centre, people spend a lot of time reading each message, working out what it is about, finding the customer and passing it to the right team. Much of this is routine, but some cases (cancellations, complaints, unclear messages) need a person's judgement. The goal is to automate the routine part reliably and make the handoff to people explicit, measurable and auditable.

## What the system does

1. **Intake:** receives a message through an API, stores it and queues it for asynchronous processing.
2. **Masking:** replaces personal data (phone numbers, e-mail addresses, account and birth numbers) with placeholders before anything is sent to a model.
3. **Understanding:** one model call with structured output: intent from a fixed list, urgency, extracted details, a short summary and a confidence level.
4. **Enrichment:** looks up the customer in a mock CRM and checks a mock list of known outages.
5. **Investigation (one agentic step):** for technical faults only, a small agent with a bounded loop checks outages, line status and recent tickets, and returns a likely cause with evidence.
6. **Routing:** rules in code turn the validated model output into a decision: the target team's queue, and whether a person must review the case.
7. **Case record:** writes the case to the mock CRM with the summary, intent, routing decision and evidence; every decision is logged.
8. **Review queue:** people confirm or correct cases waiting for review (CLI first, later a minimal web page); corrections are stored.

## Principles

- **AI only where it adds value.** The model handles what code cannot: understanding unstructured text. Decisions with consequences (routing, escalation, writing records) are made by code from validated model output.
- **A workflow by default, an agent only where open-ended investigation helps.** The one agent step has a step limit, a fixed set of read-only tools and a validated output.
- **People decide the hard cases.** Low confidence, cancellations, complaints and mismatches with the CRM always go to review.
- **Measured, not assumed.** Quality is shown by evaluation results on a labelled dataset, not by examples.
- **Untrusted input.** Customer messages can contain instructions aimed at the model; they must never be able to trigger an action.
- **Privacy by design.** Personal data is masked before it reaches a model; only synthetic data is used.
- **Auditable.** For every case it is possible to see what the model returned, which rule decided the routing, and why.
- **Spec first, code second.** Every feature starts as a spec in this repo, and the code follows the spec.

## Non-goals

- No chatbot or customer-facing conversation.
- No autonomous agent that takes actions; the investigating agent only reads and reports.
- No real customer data, and no imitation of a real company.
- No production-grade UI; the web page is minimal and for review only.
- No training or fine-tuning of language models. (A small classical classifier may be trained as a baseline in the optional confidence comparison.)

## Success criteria

- On the labelled dataset, the evaluation reports intent accuracy, per-intent precision and recall, extraction accuracy, routing accuracy and **recall on "must go to review"**, plus cost and processing time per message.
- No message in the prompt-injection scenarios triggers an action or bypasses review rules.
- Messages are processed asynchronously from intake to case record, and the review queue works end to end.
- Unit tests run in CI without calling a model; a small evaluation subset runs in CI with a model.
- A new reader can understand the design, the decisions and the limitations from the README in a few minutes.
