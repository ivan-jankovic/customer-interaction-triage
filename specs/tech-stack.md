# Tech stack

## Core

| Area | Choice | Notes |
|---|---|---|
| Language | **TypeScript** (strict mode) | TypeScript 7 runs the type check. ESLint's type-aware rules use the TypeScript 6 API (`@typescript/typescript6`) until typescript-eslint supports TS 7.1+ (decided in P01). |
| Runtime | **Node.js LTS** | |
| HTTP API | **Fastify** | Intake API; later also serves the review web page. |
| Database | **PostgreSQL** + **Kysely** | Messages, cases, decision log, review corrections, mock CRM and outage data. Kysely (typed query builder on `pg`) with its built-in migrator; migrations in `src/db/migrations/`, one per change, each table added by the phase that uses it. |
| Queue | **Redis** + **BullMQ** | Asynchronous processing with retries; Redis runs as a container in Docker Compose with append-only persistence and a volume. Client: ioredis (BullMQ's own). See "Queue consistency" below. |
| LLM | **Claude** via the **Anthropic SDK** | Structured output through tool use with a JSON Schema; model name configurable. |
| Validation | **Ajv** + **ajv-formats**, types via **json-schema-to-ts** | Every model output is validated before use; invalid output goes to review. |
| Tests | **Vitest** | Unit tests (`npm test`) never call a model (the LLM client is mocked) and need no Docker. Integration tests (`npm run test:integration`) run against the Compose services. |
| Lint & format | **ESLint**, **Prettier**, `tsc --noEmit` | typescript-eslint `recommendedTypeChecked`; Prettier with print width 120 (Markdown excluded). |
| Local setup | **Docker Compose** | PostgreSQL, Redis and (from P02) the app, one command. Images pinned to exact versions. Local only; no hosted deployment. |
| CI | **GitHub Actions** | On every pull request and push to `main`: a `checks` job (lint, format, type check, unit tests, dependency audit) and an `integration` job against the Compose services (started with `docker compose up --wait`, so CI uses the same configuration as local). Actions pinned to commit SHAs; Dependabot for npm, Actions and Compose images. From P04: an evaluation subset with a model (API key as a secret). |
| Package manager | **npm** | |

## Pipeline

```
intake (API) → store → queue → mask → understand (LLM) → enrich (CRM, outages)
   → [technical fault: investigate (agent)] → route (rules) → case record + decision log
   → review queue (if required)
```

Each step is a separate module with its own tests. Steps after "understand" never see raw personal data.

## Queue consistency

Saving a message (PostgreSQL) and enqueueing its job (Redis) are two separate writes, so a crash in between could leave a message that is never processed. The intake must guarantee that every stored message is eventually processed, e.g. with an **outbox table** written in the same transaction as the message and forwarded to the queue, or a periodic **sweep** for unprocessed messages. The approach is decided and tested in P08. Jobs are idempotent, so a message processed twice does not create two cases.

## Data model (initial)

- `interactions`: id (uuidv7), external id (the caller's own id, unique when set), channel (`email` | `chat` | `call`), language (`cs` | `sk` | `en`, nullable when unknown), raw text, received at, status, created at (from P02); masked text (P05)
- `classifications`: interaction id, intent, urgency, extracted fields, summary, confidence, model, prompt version, tokens, latency
- `investigations`: interaction id, steps taken, tools called, likely cause, evidence, confidence
- `cases`: id, interaction id, customer id (nullable), target team, needs review, reason codes, created at
- `decision_log`: case id, step, input summary, output, rule applied, timestamp
- `reviews`: case id, reviewer decision, corrected intent/team, note, reviewed at
- Mock data: `crm_customers`, `crm_services`, `crm_tickets`, `outages`

Final fields are fixed in the phase specs.

## Intents, teams and labels (finalized in P00)

Defined in code in `src/taxonomy.ts`, with definitions, examples and borderline cases in the [labelling guide](../eval/labelling-guide.md).

| Intent | Team |
| --- | --- |
| `billing_question` | `billing` |
| `technical_fault` | `technical_support` |
| `tariff_change` | `sales` |
| `cancellation` | `retention` |
| `complaint` | `complaints` |
| `other` | `general` |

- **One primary intent per message.** When several apply, precedence decides: `cancellation` > `complaint` > `technical_fault` > `billing_question` > `tariff_change` > `other`.
- **Urgency:** `low`, `normal`, `high`.
- **Review reasons in the dataset:** `cancellation`, `complaint` (by rule, from the intent) and `unclear` (by judgement). `must_review` is true exactly when there is at least one reason. Runtime reasons (confidence, CRM mismatch, …) are added in P07.
- **Fields:** `identifiers` (typed: `customer_number`, `contract_number`, `phone`, `email`, `birth_number`, `bank_account`, `iban`, each with its value exactly as written), `service_type` (`internet`, `mobile`, `tv`, `unknown`) and `area` (town in nominative form, or none).
- **Dataset record:** `{ intent, urgency, must_review, review_reasons, expected_team, fields: { identifiers, service_type, area } }`, schema in `eval/schema/`.

## Routing rules (initial)

- Target team by intent, as in the table above.
- **Always review:** `cancellation`, `complaint`, confidence below threshold, invalid model output, customer not found or ambiguous, CRM mismatch, investigation inconclusive.
- Rules live in code and are covered by unit tests; every applied rule is written to the decision log as a reason code.

## Masking

Deterministic, rule-based (no model): phone numbers, e-mail addresses, Czech birth numbers, bank account numbers, IBANs, customer and contract numbers. Formats are Czech and Slovak (e.g. +420 and +421 phone numbers, CZ and SK IBANs; birth numbers share one format); other countries are out of scope. Placeholders are typed (e.g. `[PHONE_1]`) so the model can still refer to them; the mapping stays in the database and is used for CRM lookups.

## Languages

- **Supported: Czech, Slovak and English.** Slovak is included because Slovak-speaking customers are common in Czechia. Other languages are out of scope.
- Prompts are written in English and handle messages in any of the three languages. The language each summary is written in is decided in P03.
- The dominant language of each message is recorded (`interactions.language`); messages mixing Czech and Slovak are expected.
- Evaluation reports metrics **per language** as well as overall, so the smaller English and Slovak sets are not hidden in an average. With few Slovak messages, its numbers are indicative only, and the report says so.

## The investigating agent

- Runs only for `technical_fault`.
- Hand-written loop against the Anthropic API (no agent framework); ends on the model's stop reason or a **step limit**.
- Read-only tools: `check_outages(area)`, `get_line_status(customerId)`, `get_recent_tickets(customerId)`.
- Tool errors are returned to the model as results.
- Output validated against a schema (likely cause, evidence, confidence); inconclusive or invalid → review.

## Evaluation

- **Dataset:** about 100 synthetic messages (mostly Czech, some English and Slovak), stored as JSONL in `eval/data/`. Labels: intent, urgency, key fields, expected team, must-review flag. No public datasets are used.
- **How the dataset is built:**
  1. **Labels first.** A script draws the label combinations (intent, urgency, must-review, language, channel, register such as polite, angry, terse or indirect) so that every intent and language is covered, including deliberately ambiguous cases. A model then writes one message per combination.
  2. **Two independent graders.** Two different models label every message using the labelling guide. Neither sees the chosen labels or the other's answer.
  3. **Human review of mismatches.** A message goes to review when the chosen labels and the two graders do not all agree. The reviewer confirms or corrects the labels, or has the message rewritten. Messages where all three agree are accepted, except for a random sample of about 10 that is also reviewed by hand, to catch mistakes the models share.
  4. **Record.** Each message keeps its chosen labels, both graders' labels and the final labels with a reviewed flag; `eval/data/README.md` records the models, prompt versions and review statistics.
- The generator and graders are separate from the triage prompts being evaluated, so the pipeline is not tested on labels it produced itself.
- **Metrics** (overall and per language): intent accuracy, per-intent precision and recall, confusion matrix, field extraction accuracy, routing accuracy, recall on must-review, summary quality (LLM-graded rubric), cost and latency per message.
- **Injection set:** messages containing instructions aimed at the model; pass = no action triggered and review rules still apply.
- **Runs:** full set manually (`npm run eval`), results written to `eval/results/` with model and prompt version; a small subset in CI.
- **Comparisons:** prompt versions or models compared on the same set.

## Review queue

- **CLI first:** list cases needing review, show details and evidence, confirm or correct.
- **Later, a minimal web page:** server-rendered by Fastify, no frontend framework; same actions as the CLI.

## Optional later

- **Transcription:** speech-to-text for a few synthetic call recordings at the start of the pipeline.
- **MCP server:** exposing the read-only CRM and outage tools.
- **Confidence gate comparison:** self-reported confidence vs. self-consistency vs. JEV vs. a classical baseline (scikit-learn, in a small Python script under `eval/`), compared on calibration and review recall.

## Repository layout (target)

```
specs/
  mission.md, tech-stack.md, roadmap.md   the constitution
  phases/
    NNN-pNN-<slug>/                       one folder per phase, in build order
src/
  api/          intake API, review web page
  pipeline/     mask, understand, enrich, investigate, route, record
  llm/          client, prompts (versioned), schemas
  db/           migrations, queries
  review/       CLI
eval/
  data/         labelled dataset, injection set
  results/      evaluation runs
  run.ts
test/
docker-compose.yml
CLAUDE.md
README.md
```
