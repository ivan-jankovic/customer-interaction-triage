# Roadmap

## Rules

Build in very small phases. Each phase should fit in about one session, end in something that can be demoed, and leave the app working. Finish phases in order.

Each phase's spec lives in `specs/phases/NNN-pNN-<slug>/`: a three-digit sequence number in the order the phases were built (starting at `001`), the roadmap phase number padded to two digits, and a short name (for example `005-p04-eval-harness/`). The sequence number keeps the folders in build order; the phase number links each folder to the roadmap. If replanning renumbers the phases, existing folders keep their old numbers, because they record what was built at the time.

## Working on a phase

How to start, implement and finish a phase (branch, spec folder with `requirements.md`, `plan.md` and `validation.md`, approval and merge) is described in `CLAUDE.md` in the repository root.

Phases P00–P14 are the **MVP**. P15–P17 are optional.

## ✅ P00: Intents, schemas and labelled dataset

- Final intent list, urgency levels, extracted fields, teams and must-review rules.
- The fictional company: name (checked not to belong to a real company), services, regions.
- The labelling guide: what each label means, with examples and borderline cases.
- About 100 synthetic messages (email, chat, call transcript; mostly Czech, some English and Slovak) and a separate small injection set, built in three steps (see "Dataset" under Evaluation in `tech-stack.md`):
  1. **Generate:** the labels for each message are chosen first, then a model writes a message that fits them.
  2. **Grade:** two different models label every message independently, using the labelling guide and without seeing the chosen labels.
  3. **Review:** every message where the chosen labels and the two graders do not all agree is reviewed by hand and its labels are confirmed or corrected (or the message is rewritten). A random sample of about 10 messages where all three agree is also reviewed, to catch mistakes the models share.
- Scripts for generating and grading under `eval/`; generation and grading cost money, so they run only manually.

**Demo:** the dataset with label statistics (counts per intent, channel, language) and the review statistics (how many messages were reviewed, how many labels were changed).
**Done when:** every mismatch is reviewed; the labelling guide and the dataset procedure are written down.

## ✅ P01: Project skeleton

- TypeScript project, ESLint, Prettier, Vitest; scripts `lint`, `typecheck`, `test`.
- Docker Compose with PostgreSQL and Redis; migrations set up.
- GitHub repository and CI running lint, type check and tests.

**Demo:** `docker compose up` starts the database and Redis; `npm test` passes.
**Done when:** CI is green.

## ✅ P02: Intake and storage

- Intake API endpoint: validate and store an interaction.
- A loader script that imports the dataset messages through the API.

**Demo:** the dataset is loaded and visible in the database.
**Done when:** API tests pass.

## ✅ P03: Understanding with structured output

- Prompt (versioned) and JSON Schema for the classification; Anthropic client with the model configurable.
- Validation with Ajv; invalid output is recorded as such.
- CLI command that classifies a single stored interaction.

**Demo:** classifying a few messages shows intent, fields, summary and confidence.
**Done when:** unit tests with a mocked client pass.

## ✅ P04: Evaluation harness and baseline

- `npm run eval`: runs classification over the dataset, computes accuracy, per-intent precision/recall, confusion matrix, field accuracy, cost and latency, overall and per language (Czech, Slovak, English).
- Results saved to `eval/results/` with model and prompt version.

**Demo:** the first baseline report.
**Done when:** the report is reproducible from the command.

## ✅ P05: Masking

- Rule-based masking of personal data with typed placeholders and a stored mapping.
- The understanding step only receives masked text.

**Demo:** before/after examples; the evaluation shows the effect on accuracy.
**Done when:** masking unit tests cover all data types; eval re-run.

## ✅ P06: Mock CRM and enrichment

- Mock CRM (customers, services, tickets) and outage data, seeded to match the dataset.
- Customer lookup from the masked placeholders' mapping; outage check by area.

**Demo:** a classified message enriched with the customer and any matching outage.
**Done when:** enrichment tests pass, including "not found" and "ambiguous".

## ✅ P07: Routing rules and decision log

- Routing rules in code: target team, must-review conditions, reason codes.
- Case record and decision log written for every interaction.
- Evaluation extended with routing accuracy and recall on must-review.

**Demo:** a processed message with its case, routing decision and reasons.
**Done when:** rule tests pass; evaluation reports the new metrics.

## ✅ P08: Asynchronous processing

- Queue with BullMQ on Redis: intake enqueues, a worker runs the pipeline.
- Queue consistency between PostgreSQL and Redis (outbox table or periodic sweep, see `tech-stack.md`); idempotent jobs.
- Redis persistence (append-only file and volume) in Docker Compose.
- Retries for transient model errors; failures end in review, never silently.

**Demo:** loading the dataset processes all messages in the background; a message stored while the worker or Redis is down is processed once they are back.
**Done when:** every interaction ends as exactly one case; failure paths (including a crash between storing and enqueueing) are tested.

## ✅ P09: Review queue (CLI)

- List cases needing review, show details, evidence and reasons, confirm or correct.
- Corrections stored in `reviews`.

**Demo:** reviewing a few cases from the dataset.
**Done when:** the review flow works end to end.

## P10: Investigating agent

- Bounded agent loop for `technical_fault` with read-only tools (outages, line status, recent tickets).
- Validated output; inconclusive or invalid → review.
- Evaluation: a labelled subset with expected likely causes; steps and tool calls recorded.

**Demo:** a technical fault investigated, with the tools it called and the evidence.
**Done when:** loop tests with a mocked client pass (including the step limit); evaluation reports cause accuracy.

## P11: Prompt-injection scenarios

- Run the injection set through the full pipeline.
- Harden prompts and checks where needed.

**Demo:** the injection report: no actions triggered, review rules held.
**Done when:** every injection scenario passes.

## P12: Evaluation in CI and comparisons

- A small evaluation subset runs in CI with the API key as a secret, with a pass threshold.
- A comparison of two prompt versions or two models on the full set.

**Demo:** a CI run with the evaluation summary; the comparison table.
**Done when:** CI fails if the subset drops below the threshold.

## P13: Review web page

- Minimal server-rendered page: case list, case detail with evidence and reasons, confirm/correct.

**Demo:** the review flow in the browser.
**Done when:** the page covers the same actions as the CLI.

## P14: README

- What it does, architecture diagram, pipeline, data model.
- Key decisions: workflow vs. agent, rules in code, masking, queue consistency between PostgreSQL and Redis, structured output.
- Evaluation results (tables, confusion matrix), injection results, cost and latency.
- Screenshots of the review page; limitations; next steps.

**Demo:** the README on GitHub.
**Done when:** a new reader can understand the design, the decisions and the results without asking.

**— MVP complete —**

## P15 (optional): Transcription

- Speech-to-text for a few synthetic call recordings at the start of the pipeline; evaluation of the effect on classification.

**Demo:** an audio "call" processed end to end.
**Done when:** results are documented.

## P16 (optional): MCP server

- MCP server exposing the read-only CRM and outage tools.

**Demo:** the tools used from an MCP client.
**Done when:** documented in the README.

## P17 (optional): Confidence gate comparison

Compare ways of deciding when a case is confident enough to skip review, on the same labelled dataset:
- **Self-reported confidence** from the structured output (the MVP approach).
- **Self-consistency:** classify each message several times and use the agreement rate as confidence.
- **JEV** (TypeSafe AI's decision model): probabilities over the intent options.
- **A classical baseline:** TF-IDF features with a calibrated logistic regression, evaluated with cross-validation (a small Python script in `eval/`).

Report for each: intent accuracy, calibration (expected calibration error, Brier score, reliability diagram), recall on must-review and the share of cases handled without review at a few thresholds, cost and latency.

**Demo:** the comparison table and reliability diagrams.
**Done when:** results and the chosen approach (with reasons) are documented in the README. If the dataset is too small for reliable conclusions, the README says so.

## Ideas for later (not planned)

- Automatic reply drafts for simple cases, sent only after review.
- Learning from review corrections (e.g. updating few-shot examples).
- A queue dashboard (e.g. Bull Board) for monitoring jobs.
