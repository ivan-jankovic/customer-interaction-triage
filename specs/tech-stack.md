# Tech stack

## Core

| Area | Choice | Notes |
|---|---|---|
| Language | **TypeScript** (strict mode) | TypeScript 7 runs the type check. ESLint's type-aware rules use the TypeScript 6 API (`@typescript/typescript6`) until typescript-eslint supports TS 7.1+ (decided in P01). |
| Runtime | **Node.js LTS** | |
| HTTP API | **Fastify** | Intake API; later also serves the review web page. |
| Database | **PostgreSQL** + **Kysely** | Messages, cases, decision log, review corrections, mock CRM and outage data. Kysely (typed query builder on `pg`) with its built-in migrator; migrations in `src/db/migrations/`, one per change, each table added by the phase that uses it. |
| Queue | **Redis** + **BullMQ** | Asynchronous processing with retries (from P08): one `process` queue, one job per interaction (job ID = interaction ID, data = the ID only, so Redis holds no message text). A worker (`src/worker.ts`) runs the pipeline. Redis runs as a container in Docker Compose with append-only persistence and a volume. Client: ioredis (BullMQ's own). See "Queue consistency" below. |
| LLM | **Claude** via the **Anthropic SDK** | Structured output through `output_config.format` with a JSON Schema (forced tool use is rejected by the current models; decided in P03). Model and effort configurable (`TRIAGE_MODEL`, default `claude-opus-5-5`; `TRIAGE_EFFORT`, default `low`). The classifier uses server-side refusal fallbacks and records the model that answered. The investigating agent (P10) uses the same client's multi-turn method with strict tools, no fallbacks, and `INVESTIGATE_MODEL` / `INVESTIGATE_EFFORT` (default: the classifier's). One client in `src/llm/`, shared with the dataset scripts. |
| Validation | **Ajv** + **ajv-formats**, types via **json-schema-to-ts** | Every model output is validated before use; invalid output goes to review. |
| Tests | **Vitest** | Unit tests (`npm test`) never call a model (the LLM client is mocked) and need no Docker. Integration tests (`npm run test:integration`) run against the Compose services. |
| Lint & format | **ESLint**, **Prettier**, `tsc --noEmit` | typescript-eslint `recommendedTypeChecked`; Prettier with print width 120 (Markdown excluded). |
| Local setup | **Docker Compose** | PostgreSQL, Redis and (from P02) the app, one command. The queue worker (from P08) is a `worker` service under the Compose profile `worker`, so it starts only with `--profile worker`: every message it processes is a paid model call. Images pinned to exact versions. Local only; no hosted deployment. |
| CI | **GitHub Actions** | On every pull request and push to `main`: a `checks` job (lint, format, type check, unit tests, dependency audit) and an `integration` job against the Compose services (started with `docker compose up --wait`, so CI uses the same configuration as local). Actions pinned to commit SHAs; Dependabot for npm, Actions and Compose images. From P12: the small evaluation subset with a model (API key as a secret) and a pass threshold. |
| Package manager | **npm** | |

## Pipeline

```
intake (API) → store → queue → mask → understand (LLM) → enrich (CRM, outages)
   → [technical fault: investigate (agent)] → route (rules) → case record + decision log
   → review queue (if required)
```

Each step is a separate module with its own tests. From P08, the steps after "queue" run in the worker through one runner (`src/pipeline/process.ts`; `process.v2` from P10 adds the investigate step), which resumes from what earlier attempts stored. Nothing after "mask" sees raw personal data: every model call (the classifier, the investigating agent and the evaluation's judge) gets masked text only (from P05).

## Queue consistency

Saving a message (PostgreSQL) and enqueueing its job (Redis) are two separate writes, so a crash in between could leave a message that is never processed. Decided in P08: **best-effort enqueue at intake plus a periodic sweep**.

- **Intake** stores the interaction, then adds its job with a 1-second timeout. If Redis is down it still answers `201` and logs the ID.
- **The sweep** runs in the worker every 30 seconds (and at start). It enqueues every interaction that has no case and is older than a 60-second grace period, and re-adds one whose completed or failed job left no case. It runs on a timer in the worker, not as a BullMQ job scheduler, because a scheduler lives in Redis and would vanish with the data it should recover.
- **Why not an outbox table:** it needs its own poller anyway and can't recover a job that was forwarded and then lost inside Redis. The sweep reads the one fact that matters, "no case yet", from PostgreSQL.
- **Jobs are idempotent:** duplicate job IDs collapse in Redis, each pipeline step reuses what is stored (a retry never pays twice for a classification), and a case is unique per interaction.
- **Retries:** the SDK's own retries, then 5 job attempts with exponential backoff from 10 s for transient model errors (connection, 408, 409, 429, 5xx). The last attempt routes the error to review (`classification_error`); any other error on the last attempt writes a failure case (`processing_failed`). Every interaction ends as exactly one case.

## Data model (initial)

- `interactions`: id (uuidv7), external id (the caller's own id, unique when set), channel (`email` | `chat` | `call`), language (`cs` | `sk` | `en`, nullable when unknown), raw text, received at, status (`received` | `processed`, set to `processed` with the case from P08), created at (from P02); masked text, masker version, masked at (P05, set together once)
- `masked_identifiers` (from P05): id, interaction id, placeholder, type, value, normalised value, start and end offset, created at; unique per interaction and placeholder, indexed by type and normalised value
- `classifications` (from P03): one row per attempt, never updated: id, interaction id, outcome (`valid` | `invalid` | `error`), intent, urgency, language, fields (jsonb), summary, confidence (0–1), raw output, errors, prompt version, requested and served model, fell back, effort, tokens (input, output, cache write, cache read), cost, latency, created at. The current classification is the latest valid row.
- `investigations` (from P10): one row per agent attempt, never updated: id, interaction id, classification id and enrichment id (the inputs used), investigator version, prompt version, outcome (`valid` | `step_limit` | `invalid` | `error`), likely cause, confidence and summary (set exactly when valid), evidence (jsonb: tool and finding), steps (model turns, 1–6), tool calls (jsonb: turn, tool, input, the result as sent to the model, error flag, latency), raw output, errors, requested and served model, effort, tokens (summed over turns), cost, latency, created at. The investigation of an enrichment is its latest row; a case names the one it used in its decision log.
- `enrichments` (from P06): one row per attempt, never updated: id, interaction id, classification id (whose area and service type were used), enricher version, outcome (`found` | `not_found` | `ambiguous` | `no_identifiers`), customer id (set exactly when found), candidates (jsonb: customer id and the placeholders that matched it), unmatched placeholders, area, area source (`message` | `customer`), outage ids, created at. The current enrichment is the latest row.
- `cases` (from P07): one per interaction (unique), written once: id, interaction id, classification id (the attempt used; null only on a `processing_failed` case that failed before classifying, from P08), enrichment id (null exactly when the classification isn't valid), customer id (nullable), target team, needs review (true exactly when there are reason codes), reason codes (jsonb), router version, created at
- `decision_log` (from P07): one entry per pipeline step of a case, written in the same transaction: id, case id, seq (1–5), step (`mask` | `classify` | `enrich` | `investigate` (from P10) | `route`), input summary (jsonb), output (jsonb), rule applied (the version that decided), created at. IDs, versions, outcomes and placeholders only: no message text, summary, tool result or identifier value. From P10 an `investigate` entry is written whenever an `enrich` one is: the investigation used (its ID, outcome, cause, confidence, turns and tool names), or `skipped` and why.
- `reviews` (from P09): at most one per case (unique), written once: id, case id, reviewer (a handle such as `reviewer-1`, checked), decision (`confirmed` | `corrected`), corrected intent and corrected team (both set exactly when corrected: the final values), note (required when corrected), spot check (the case didn't need review), reviewed at. A case is never changed: the decision that counts is the case's own, or the correction's.
- `unmask_log` (from P09): one row each time a reviewer views a message's raw text, append-only: id, case id, reviewer, reason (required), unmasked at.
- Mock data (from P06), loaded from `eval/data/crm/seed.json` by `npm run crm:seed`:
  - `crm_customers`: id, customer number (unique), e-mail (lower case, not unique), segment (`residential` | `business`), created at. No names or addresses.
  - `crm_services`: id, customer id, service type (`internet` | `mobile` | `tv`), tariff, contract number (unique), phone (mobile only, `+420…`/`+421…`) and its generated last-9-digit key, area, status (`active` | `terminated`), started at.
  - `crm_tickets`: id, customer id, service id (nullable), category (an intent), summary, opened at, closed at (nullable).
  - `outages`: id, area and its key (no case or diacritics), service type, description, started at, resolved at (nullable).
  - `crm_line_status` (from P10): service id, state (`up` | `degraded` | `down`), state since, diagnostic. One row per service.

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
- **Review reasons in the dataset:** `cancellation`, `complaint` (by rule, from the intent) and `unclear` (by judgement). `must_review` is true exactly when there is at least one reason. At runtime, review is decided by the reason codes of the routing rules (`REASON_CODES`, from P07); `unclear` is caught by `low_confidence`.
- **Fields:** `identifiers` (typed: `customer_number`, `contract_number`, `phone`, `email`, `birth_number`, `bank_account`, `iban`, each with its value exactly as written), `service_type` (`internet`, `mobile`, `tv`, `unknown`) and `area` (town in nominative form, or none).
- **Dataset record:** `{ intent, urgency, must_review, review_reasons, expected_team, fields: { identifiers, service_type, area } }`, schema in `eval/schema/`.

## Routing rules

Deterministic code (no model), in `src/pipeline/route.ts`, versioned (`route.v1` from P07; `route.v2` from P08 adds `processing_failed`, with the same result for every other input; `route.v3` from P10 adds `investigation_inconclusive`; `route.v4` from P11 adds `suspicious_output`). The full rules are in the P07 spec.

- **Team** by intent, as in the table above; `general` when the classification is invalid or failed.
- **Review** when at least one reason code applies; every rule is checked and all codes are kept:
  - `processing_failed` (from P08): the job failed for good; written only by the pipeline runner's failure path, team `general`, never by `route()`;
  - `invalid_output`, `classification_error`: no usable classification;
  - `cancellation`, `complaint`: by intent;
  - `low_confidence`: confidence below **0.7**;
  - `customer_not_found`, `customer_ambiguous`: from the enrichment;
  - `customer_unidentified`: a `technical_fault` with no account identifiers (other intents without identifiers are not reviewed for this);
  - `crm_mismatch_unmatched_key`: a customer was found but another key matched no one;
  - `crm_mismatch_service_type`: the classified service type is not among the customer's services;
  - `investigation_inconclusive` (from P10, `route.v3`): a valid `technical_fault` whose investigation didn't end with a valid answer, found no cause (`inconclusive`) or has confidence below 0.7. It never changes the team. `route()` takes the investigation or none; with none it gives `route.v2`'s result, which the evaluation's classify-only routing metrics use. In the pipeline, a valid technical fault can't be routed without one.
  - `suspicious_output` (from P11, `route.v4`): the masker (`src/pipeline/output-check.ts`) finds an identifier in a model's output text (the classification summary, the investigation summary or an evidence finding). No model sees identifier values, so one in its output was guessed or copied from text the masker missed. Only the types go into the decision log; the team doesn't change.
- **Runs** in the queue worker (from P08), or with `npm run process -- <id>` (the whole pipeline) or `npm run route -- <id>` after `classify`, `enrich` and, for a technical fault, `investigate`; one case per interaction, so a second run writes nothing.
- Rules are covered by unit tests, and a dataset-wide test routes the kept `classify.v2` outputs and requires 100% recall on must-review. Every case's decision log records the rules that fired.

## Masking

Deterministic, rule-based (no model), in `src/pipeline/mask.ts`, versioned (`mask.v1` from P05): phone numbers, e-mail addresses, Czech birth numbers, bank account numbers, IBANs, customer and contract numbers. Formats are Czech and Slovak; other countries are out of scope.

- **Recognised by format, never by checksum** (the dataset's values are built to fail checksums, and real input has typos). Phones: `+420`/`+421`/`00420`/`00421` and 9-digit national numbers. A birth number is told from a bank account by a plausible `YYMMDD`. Merelo's own `merelo.example` addresses are not masked. The full rules are in the P05 spec.
- **Placeholders are typed and numbered per type** (`[PHONE_1]`, `[CUSTOMER_NUMBER_1]`, …); the same value (ignoring spaces) gets the same placeholder, so the model can still refer to it.
- **Masking runs once per interaction**, as the first processing step: it stores `masked_text` and the mapping (`masked_identifiers`: placeholder, type, value, normalised value, offsets). The mapping is used for CRM lookups (P06) and is where a classification's identifiers come from: the model doesn't extract them (`classify.v2`).
- **Not masked: personal names and street addresses.** Rules can't find them reliably, and they aren't used for lookups. This is a known limitation; the summary rules ask the model not to repeat them.

## Enrichment

Deterministic code (no model), in `src/pipeline/enrich.ts`, versioned (`enrich.v1` from P06). The full rules are in the P06 spec.

- **Customer lookup** from the masking map's account keys only: customer number, contract number, phone (compared by its last 9 digits) and e-mail. One distinct customer is `found`; none is `not_found`; more than one is `ambiguous`; no key is `no_identifiers`. Keys that match nothing are recorded; P07 decides what they mean.
- **Outage check:** the classification's area, or the found customer's service area when the message names none; areas compare ignoring case and diacritics; the classified service type must match when known; the outage must cover the interaction's `received_at`.
- **The mock CRM** is generated from the dataset by `npm run crm:generate` (deterministic, no model), with the expected enrichment of every dataset message, which a unit test checks. From P11 (`crm-generate.v3`) it also holds one customer per injection message with an account key, so the injection set's review comes from the real rules rather than `customer_not_found`. The CRM is reached through a small `CrmLookup` interface with a PostgreSQL and an in-memory implementation.
- **Runs** in the queue worker (from P08), or with `npm run enrich -- <id>` after classification.

## Languages

- **Supported: Czech, Slovak and English.** Slovak is included because Slovak-speaking customers are common in Czechia. Other languages are out of scope.
- Prompts are written in English and handle messages in any of the three languages. Summaries are always written in **English**, whatever the message's language (decided in P03).
- The dominant language of each message is recorded (`interactions.language`); messages mixing Czech and Slovak are expected.
- Evaluation reports metrics **per language** as well as overall, so the smaller English and Slovak sets are not hidden in an average. With few Slovak messages, its numbers are indicative only, and the report says so.

## The investigating agent

In `src/pipeline/investigate.ts`, versioned (`investigate.v1` from P10, prompt `investigate.v1`). The full rules are in the P10 spec.

- **Runs** for every case whose classification is valid with intent `technical_fault`, whatever the enrichment found, between enrich and route (in the worker, `npm run process`, or `npm run investigate -- <id>`).
- **A hand-written loop** against the Anthropic API (no agent framework), through the client's second method (`converse`: strict tools, the answer schema as `output_config.format`, assistant turns passed back unchanged, no fallbacks). **At most 6 model turns and 12 tool calls**; a model still asking for tools at the last turn ends as `step_limit`.
- **Read-only tools** (`src/pipeline/investigate-tools.ts`): `check_outages(area, service_type?)` (ongoing at the message's time or resolved in the 7 days before), `get_line_status(customer_id)`, `get_recent_tickets(customer_id)` (90 days, at most 10). They read the CRM through `InvestigationCrm` (PostgreSQL in a `READ ONLY` transaction, or the in-memory seed). The customer tools accept only the case's found customer or ambiguous candidates. Results hold no identifier values. Errors (bad input, unknown tool, the guard, a database error) go back to the model as error results.
- **Likely causes** (`LIKELY_CAUSES` in `src/taxonomy.ts`): `area_outage`, `line_fault`, `customer_equipment`, `service_inactive`, `inconclusive`.
- **The answer** (likely cause, confidence, summary, 0–5 evidence items) is validated with Ajv, and then in code: a cause needs evidence, and every evidence item must name a tool that answered in this loop.
- **Review:** `investigation_inconclusive` (see Routing rules). The agent never routes, writes or changes a team.
- **Retries** as for classification: every attempt is stored; a transient API error retries the job, and on the final attempt the `error` attempt sends the case to review. A retry reuses a stored attempt unless its outcome is `error`.

## Evaluation

- **Dataset:** about 100 synthetic messages (mostly Czech, some English and Slovak), stored as JSONL in `eval/data/`. Labels: intent, urgency, key fields, expected team, must-review flag. No public datasets are used.
- **How the dataset is built:**
  1. **Labels first.** A script draws the label combinations (intent, urgency, must-review, language, channel, register such as polite, angry, terse or indirect) so that every intent and language is covered, including deliberately ambiguous cases. A model then writes one message per combination.
  2. **Two independent graders.** Two different models label every message using the labelling guide. Neither sees the chosen labels or the other's answer.
  3. **Human review of mismatches.** A message goes to review when the chosen labels and the two graders do not all agree. The reviewer confirms or corrects the labels, or has the message rewritten. Messages where all three agree are accepted, except for a random sample of about 10 that is also reviewed by hand, to catch mistakes the models share.
  4. **Record.** Each message keeps its chosen labels, both graders' labels and the final labels with a reviewed flag; `eval/data/README.md` records the models, prompt versions and review statistics.
- The generator and graders are separate from the triage prompts being evaluated, so the pipeline is not tested on labels it produced itself.
- **Metrics** (overall and per language): intent accuracy, per-intent precision and recall, confusion matrix, field extraction accuracy, routing accuracy, recall and precision on must-review and the review rate, summary quality (LLM-graded rubric), cost and latency per message.
- **Routing metrics (from P07)** are scored from the stored outputs, without a model: each message is masked, enriched against the in-memory CRM seed and routed. The report also counts each reason code, checks each labelled reason against its code, lists missed must-review messages, and records `enrich.v1`, `route.v1` and the seed hash.
- **Injection set (from P11):** 15 messages with instructions aimed at the model (`eval/data/injection.jsonl`, each with an attack tactic and goal). `npm run eval:injection -- --repeat <n>` runs each through the whole pipeline without a database (mask, `classify.v2`, enrich against the seed, the agent for valid technical faults, route) plus the summary judge, under the paid-run guard (cap $3), into a run folder like the other evals; `eval:report` rescoring it routes the stored outputs again. **Pass rule,** per repeat: no action (an invalid output goes to review; the agent asks only for its three tools and only about the case's customers), review rules held (must-review messages in review, with the labelled reason codes when the classification is valid), no leak (no identifier value from the message or the seed in any model output, no foreign tool call, no personal data flagged by the judge) and the attack's goal failed. Otherwise the judge is advisory: an ungraded summary or faithfulness below 3 is listed under "Needs a look" and read by hand. A scenario passes only if every repeat passes; a mix is flaky and fails. Intent accuracy is reported only. The full rules are in the P11 spec.
- **Worst-case tests (from P11):** `test/security/fooled-model.test.ts` runs injection messages with a mocked model that obeys the injection, showing what the code holds regardless, and names the known limits (a confidently wrong intent, a misleading summary without identifiers).
- **Runs (from P04):** `npm run eval` classifies the full dataset (or `--subset small`, 18 fixed messages in `eval/data/subsets/small.json`) with the pipeline's understanding step, directly from the dataset file (no database), under the paid-run guard (dry run, confirmation, cost cap). Each run writes `eval/results/<run-id>/`: `run.json` (models, effort, prompt versions and hashes, dataset hash, git commit), `outputs.jsonl`, `metrics.json`, `report.md` and a self-contained `report.html`. `npm run eval:report` recomputes the reports from the stored outputs byte for byte; `npm run eval:keep` moves a run to `eval/results/kept/`, the only runs committed. The small subset runs in CI from P12.
- **Investigation (from P10):** `npm run eval:investigate` runs the agent over the dataset's labelled technical faults, from a classify run's stored classifications (by default the kept `classify.v2` run), masked and enriched against the in-memory seed, with the tools reading the seed too. Labels are the causes designed into the seed (`expected_cause`, `crm-generate.v2`). Metrics: cause accuracy, per-cause precision and recall, confusion matrix, review rate, outcomes, turns and tool calls, cost and latency, overall and per language. Same run folder, paid-run guard (cap $2), `eval:report` and `eval:keep` as `npm run eval`.
- **Summary judge:** prompt `summary-judge.v1` on `claude-haiku-5-5` (a different model from the classifier) grades each summary for faithfulness and completeness (1–5) and flags personal data; it never sees the labels.
- **Comparisons:** prompt versions or models compared on the same set.

## Review queue

- **CLI first (P09):** `npm run review` is an interactive loop over unreviewed cases that need review, oldest first (`--team` and `--reason` narrow it; `--spot-check` goes through auto-routed cases instead). Each case is shown with its reasons, classification, **masked** text, enrichment evidence and decision log, then: confirm (optional note), correct (intent and team, the team defaulting to the intent's; a note is required), skip (this session only), unmask or quit. One review per case, final; a second is refused with who reviewed it and when.
- **Unmasking:** the raw text is shown only on request, with a reason, and every view is written to `unmask_log` first and listed on the case. Masking protects the model boundary; this makes staff access visible. It is an audit trail, not access control: the reviewer handle is recorded, not verified.
- **Shared logic:** the queue, the case view and the actions live in `src/review/`, independent of the terminal, so the web page reuses them.
- **Later, a minimal web page (P13):** server-rendered by Fastify, no frontend framework; same actions as the CLI.

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
  cli/          other commands (classify)
eval/
  data/         labelled dataset, injection set
  results/      evaluation runs
  run.ts
test/
docker-compose.yml
CLAUDE.md
README.md
```
