# Phase 3 — Understanding with structured output: Requirements

## Context

This is phase P03 in [roadmap.md](../../roadmap.md). P02 left an intake API that stores interactions in PostgreSQL, and a loader that put the 100 dataset messages (and the 15 injection messages) there. P00 left a small Anthropic client for the dataset scripts (`eval/lib/llm.ts`), with structured output and refusal handling.

P03 builds step 3 of the pipeline in [mission.md](../../mission.md): "Understanding: one model call with structured output: intent from a fixed list, urgency, extracted details, a short summary and a confidence level." It is the first place the app itself calls a model. The output is validated in code and stored, valid or not, so P04 can measure it and P07 can route on it. The principles that matter most here are "AI only where it adds value", "Untrusted input" and "Auditable".

## Scope

In scope:

- **A versioned classification prompt.** `src/llm/prompts/classify.v1.md` holds the company context, the intent and urgency definitions, the precedence rule and the field rules, condensed from the [labelling guide](../../../eval/labelling-guide.md). It has a few hand-written examples and no dataset messages.
- **The output JSON Schema** (`src/llm/schemas/classification.schema.ts`, details under Data). It is sent to the API as `output_config.format` and validated in full with Ajv afterwards.
- **One shared Anthropic client in `src/llm/`.**
  - The client: `eval/lib/llm.ts` moves to `src/llm/client.ts`.
  - Prices: the price table moves to `src/llm/pricing.ts`.
  - Prompt loading: the prompt loader moves to `src/llm/prompts.ts`.
  - The P00 dataset scripts import all three from there and behave as before.
- **Server-side refusal fallbacks** for the classifier (`fallbacks: "default"`). The model that actually answered is recorded. The P00 dataset scripts keep fallbacks off.
- **The understanding step** in `src/pipeline/understand.ts`. It takes the message text and channel and returns one classification attempt. The attempt's outcome is `valid`, `invalid` or `error`, and it carries everything needed for the audit.
- **The `classifications` table** (a migration), with one row per attempt.
- **A CLI**: `npm run classify -- <id | external_id>` classifies one stored interaction and prints the result, its cost and its latency. `--dry-run` prints the rendered prompt and the token count from the free token-counting endpoint, without classifying.
- **Configuration:**
  - `ANTHROPIC_API_KEY` is needed only for a real run.
  - `TRIAGE_MODEL` defaults to `claude-opus-5-5`.
  - `TRIAGE_EFFORT` defaults to `low`.
- **A prompt version registry**: `src/llm/prompts/versions.json` records a SHA-256 hash for every prompt file, the P00 ones included. A unit test fails if a published version's text changes.
- **Tests:**
  - Unit tests with a mocked client (no model calls).
  - Integration tests for the table and for the CLI flow with a mocked client.
- **Docs:**
  - Edits to [tech-stack.md](../../tech-stack.md): structured output via `output_config.format` instead of "through tool use", the summary language, and the `classifications` columns.
  - The README gets the classify command.
  - Approving this spec approves these edits.

Out of scope (later phases):

- Masking. P03 sends the stored raw text, as an explicit, temporary exception (see Decisions); P05 adds masking.
- The evaluation run over the dataset, metrics and `eval/results/` (P04).
- Routing, review reasons and the confidence threshold (P07). The model does **not** decide `must_review` or the team.
- Queueing and job retries (P08). Classification here is started by hand from the CLI.
- CRM lookup (P06) and the investigating agent (P10).
- Hardening against prompt injection beyond the framing in the prompt (P11).

## Data

### Model output (`classification.schema.ts`)

```json
{
  "intent": "technical_fault",
  "urgency": "high",
  "language": "cs",
  "fields": {
    "identifiers": [{ "type": "customer_number", "value": "MR29861166" }],
    "service_type": "internet",
    "area": "České Budějovice"
  },
  "summary": "Customer reports no internet connection since this morning and asks for a technician.",
  "confidence": 0.86
}
```

| Field | Rule |
| --- | --- |
| `intent` | One of the six intents in `src/taxonomy.ts`. When several apply, the primary one follows the precedence rule. |
| `urgency` | `low`, `normal` or `high`. |
| `language` | The message's dominant language: `cs`, `sk` or `en`. |
| `fields.identifiers` | Typed identifiers, each `value` exactly as written in the message (the same rules as the dataset labels). |
| `fields.service_type` | `internet`, `mobile`, `tv` or `unknown`. |
| `fields.area` | A town in the nominative form, or `null`. |
| `summary` | English, one or two sentences, 1–400 characters. It names no personal data beyond what routing needs. |
| `confidence` | 0–1: the model's confidence that `intent` is correct. |

- **Validation with Ajv.** The full schema is checked with Ajv. The API's structured output drops length and number limits ([P00 notes](../001-p00-intents-schemas-labelled-dataset/requirements.md)), so Ajv enforces `summary`'s length and `confidence`'s range.
- **No routing fields.** The schema has no `must_review`, `review_reasons` or team. Those come from code in P07 (mission: "Decisions are made in code").

### Table `classifications`

One row per attempt; rows are never updated. The current classification of an interaction is its latest `valid` row.

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | Primary key, `uuidv7()` |
| `interaction_id` | `uuid` | Foreign key to `interactions`, not null, indexed with `created_at` |
| `outcome` | `text` | `valid`, `invalid` (output missing, unparsable or failing the schema, a refusal, or `max_tokens`) or `error` (the API call failed) |
| `intent`, `urgency`, `language` | `text` | Set exactly when `outcome = 'valid'` (check constraint) |
| `fields` | `jsonb` | The same rule as `intent` |
| `summary` | `text` | The same rule as `intent` |
| `confidence` | `real` | The same rule as `intent`; 0–1 |
| `raw_output` | `text`, nullable | The model's text exactly as returned, also when it is invalid |
| `errors` | `jsonb` | A list of strings: validation errors, the refusal category or the API error. Empty when valid. |
| `prompt_version` | `text` | For example `classify.v1` |
| `requested_model`, `served_model` | `text` | `served_model` comes from the response, and differs from `requested_model` after a fallback |
| `fell_back` | `boolean` | True when the response shows that a fallback model answered |
| `effort` | `text` | The effort level sent |
| `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` | `integer` | From `usage`; 0 on `error` |
| `cost_usd` | `numeric`, nullable | Computed from the served model's price; null if that model has no known price |
| `latency_ms` | `integer` | Wall-clock time of the call, including SDK retries |
| `created_at` | `timestamptz` | Default `now()` |

## Decisions

### Requirements

| Decision | Choice | Why |
| --- | --- | --- |
| Confidence | One number from 0 to 1, for the intent | P07 compares it with a threshold in code, and P17 measures calibration (ECE, Brier score). Decided during spec review. |
| Summary language | English, always | Decided during spec review. It also makes P04's LLM-graded summary rubric simpler. |
| Masking before P05 | The raw text is sent to the model in P03 and P04. This is a temporary, explicit exception to "mask before the model" (CLAUDE.md), and it is allowed because every message is synthetic. The understanding step takes the text as an argument, so P05 only changes what is passed in. P04's baseline gives the "before masking" numbers that P05 compares against. | Decided during spec review. |
| Storage | A row per attempt; invalid and failed attempts are stored too, with the raw output and the errors | Full audit trail ([mission.md](../../mission.md), Auditable); P04 counts invalid outputs. Decided during spec review. |
| Invalid output | Stored as `invalid`, with no retry. The SDK still retries transient API errors (429, 5xx; `maxRetries: 3`), and P08 adds job-level retries. | With `output_config.format`, invalid output should be rare, and one call per attempt keeps costs easy to account for. In P07, an invalid result sends the case to review. Decided during spec review. |
| Language in the output | The model reports the dominant language | `interactions.language` is optional since P02. It is stored only in `classifications`; filling `interactions.language` from it is left for later. Claude's proposal. |

### Plan

| Decision | Choice | Why |
| --- | --- | --- |
| Model and effort | `claude-opus-5-5` at effort `low` by default; `TRIAGE_MODEL` and `TRIAGE_EFFORT` override them | Decided during spec review. On Opus 5.5 thinking cannot be turned off (adaptive), so effort is the cost lever, and classification rarely gains from deep thinking. P04 measures it; P12 compares models. |
| Structured output | `output_config.format` with the JSON Schema; no tool use | Forced `tool_choice` returns a 400 on current models (found in P00). tech-stack.md's "through tool use" is corrected. |
| Refusal fallbacks | The classifier sends `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). `served_model` and `fell_back` record what happened, and P04 reports the fallback count. A refusal by the whole chain is `invalid`. | A safety decline shouldn't send a case to review when another model can answer it; the audit trail still shows which model did. Decided during spec review. The P00 graders keep fallbacks off, because grader independence depends on knowing the model. |
| Client location | `src/llm/client.ts`, shared with the dataset scripts; `fallbacks` is an option per request | One client, tested once. Decided during spec review. |
| Prompt content | Company context and the definitions, precedence and field rules condensed from the labelling guide, plus 3–4 hand-written examples. No dataset messages, and nothing copied from the guide's borderline examples. | The model is briefed as a human agent would be, and the evaluation set stays unseen. Decided during spec review. |
| Untrusted input | The message goes in the user turn inside `<customer_message>` tags. Any `<` or `>` in the text is escaped, so the message cannot close the tag. The system prompt says that instructions inside the message are data and must never be followed. | [mission.md](../../mission.md), Untrusted input. P11 tests this fully. |
| Prompt caching | The system prompt (identical for every call) is cached with `cache_control`; only the user turn varies | Cuts the cost of P04's 100-message runs. Caching applies only above a minimum prefix length, so the dry run reports the token count. |
| `max_tokens` | 4,000 | Thinking counts towards it; the answer itself is a few hundred tokens. Hitting the limit gives `invalid`. |
| Code layout | `src/llm/` (client, pricing, prompts, schemas), `src/pipeline/understand.ts` (the step), `src/db/classifications.ts` (store) and `src/cli/classify.ts` (CLI) | Follows the target layout in tech-stack.md; `src/cli/` is new, for commands that aren't the review CLI. |
| CLI input | An interaction `id` or `external_id`, plus `--dry-run` | Decided during spec review. |

### Validation

| Decision | Choice | Why |
| --- | --- | --- |
| Paid demo | 5 messages: one each of `billing_question`, `technical_fault`, `tariff_change` and `complaint`, plus one injection message. About $0.05 on Opus 5.5 at low effort. Claude asks before running it, and the output goes into the PR description. | Decided during spec review. |
| Prompt versioning | A hash registry (`src/llm/prompts/versions.json`) and a unit test | A published prompt can't change silently. Decided during spec review. |

## Notes

- **P00 code moves.** `eval/dataset/generate.ts`, `grade.ts`, `eval/lib/run-guard.ts`, `eval/lib/cost.ts` and their tests will import the client, prices and prompt loader from `src/llm/`. Their behaviour and assertions must not change. The P00 prompt files stay in `eval/prompts/`, but they are listed in the hash registry too.
- **Fallbacks and structured output together** are checked against the current SDK types and docs before the client is written (plan 1.1). If the two can't be combined, the conflict is raised for a decision rather than worked around.
- **The fallback model's price.** `fallbacks: "default"` picks the fallback model by refusal category, so its ID is not known in advance. If it has no entry in `pricing.ts`, `cost_usd` is stored as null and the CLI says so; nothing fails.
- **Personal data in this table.** `fields.identifiers` and `raw_output` contain identifiers from the raw text. That is accepted with the masking exception above. After P05, the model sees only placeholders, so these columns will hold placeholders too.
- **Interaction status is unchanged.** P03 does not move interactions out of `received`; P08 adds the processing statuses.
