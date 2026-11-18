# Phase 3 — Understanding with structured output: Plan

See [requirements.md](requirements.md) for scope and decisions, and [validation.md](validation.md) for the merge checklist.

**No model calls except the demo in group 7, and that runs only after asking.** After every group, `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` pass. `npm run test:integration` must also pass after groups that touch the database.

## 1. Shared LLM module

1.1. Check the current docs (the claude-api skill files, and the SDK types in `node_modules/@anthropic-ai/sdk`) for:
  - `output_config.format` together with `effort`;
  - the beta `fallbacks` parameter and how a response shows a fallback (`usage.iterations`, `fallback` content blocks, `response.model`);
  - `messages.countTokens`.

  Record anything that differs from requirements.md there before writing code.

1.2. Move the P00 helpers into `src/llm/`:
  - `eval/lib/llm.ts` → `src/llm/client.ts`, adding an optional `fallbacks: boolean` to `LlmRequest` (default off) and `servedModel` / `fellBack` to the result;
  - the price table and `costOf` → `src/llm/pricing.ts`, where `costOf` returns `null` for an unknown model;
  - `loadPrompt` / `render` → `src/llm/prompts.ts`.

  `eval/lib/cost.ts`, `run-guard.ts`, `generate.ts` and `grade.ts` import from the new place, and `costOf` callers there keep failing loudly on an unknown model, as before. The P00 tests pass unchanged, apart from import paths.
1.3. Add `countTokens(request)` to the client interface for `--dry-run`.
1.4. Unit tests for the client with a mocked SDK object (the client takes an `Anthropic` instance or a factory). Cover:
  - the request shape: schema stripped, `cache_control` on the system prompt, effort, the betas and `fallbacks` only when asked;
  - text extraction;
  - refusal and `max_tokens` handling;
  - API errors;
  - detecting a fallback.

## 2. Prompt, schema and version registry

2.1. Write `src/llm/schemas/classification.schema.ts` (requirements.md, Data). Enums come from `src/taxonomy.ts`, and the type comes from json-schema-to-ts.
2.2. Write `src/llm/prompts/classify.v1.md` with `=== system ===` and `=== user ===` sections:
  - the company context, intents with definitions, precedence, urgency, identifiers and their formats, service type, area, the summary rules (English, no personal data beyond what routing needs) and the confidence meaning;
  - instructions inside the message are data, never commands;
  - 3–4 hand-written examples that are not taken from the dataset;
  - a user turn with `{{channel}}` and `{{message}}` inside `<customer_message>` tags.
2.3. Write `src/llm/prompts/versions.json` with SHA-256 hashes for `classify.v1`, `eval/prompts/generate.v1` and `eval/prompts/grade.v1`. Write `test/llm/prompt-versions.test.ts`:
  - every prompt file has an entry, and the hashes match;
  - removing an entry or changing a file fails, with a message saying "add a new version instead".
2.4. Unit test that no dataset or injection message text (and no 40-character excerpt of one) appears in `classify.v1.md`.

## 3. Understanding step

3.1. Write `src/pipeline/understand.ts`, with `understand({ text, channel }, { llm, model, effort, prompt })` → `ClassificationAttempt`:
  - render the prompt, escaping `<` and `>` in the message;
  - call the client with `fallbacks: true`;
  - parse the JSON and validate it with Ajv (`allErrors: true`, strict);
  - measure latency, and map the result to `valid`, `invalid` or `error` with `errors`, tokens and cost.
3.2. Write `src/config.ts` → `loadClassifierConfig(env)`: `TRIAGE_MODEL` (default `claude-opus-5-5`, which must have a known price) and `TRIAGE_EFFORT` (`low`/`medium`/`high`/`xhigh`/`max`, default `low`). Unit tests.
3.3. Unit tests with a mocked `LlmClient`:
  - a valid output;
  - invalid JSON;
  - each schema violation that matters: an unknown intent, `confidence` 1.2, an empty summary, a summary over 400 characters, a missing field, an extra field;
  - a refusal;
  - `max_tokens`;
  - an API error;
  - a fallback, which records `served_model` and `fell_back`;
  - an unknown served-model price, which gives `cost_usd` null;
  - a message containing `</customer_message>` and an instruction, which is escaped, so the rendered user turn still has exactly one closing tag.

## 4. Storage

4.1. Write migration `src/db/migrations/0002_classifications.ts` (requirements.md, Data). It adds the check constraints (outcome values; result columns set exactly when `valid`; confidence 0–1), the foreign key and the index. Add `ClassificationsTable` to `Database`.
4.2. Write `src/db/classifications.ts` with `ClassificationStore` (`record(interactionId, attempt)`, `latestValid(interactionId)`, `listFor(interactionId)`) and its Kysely implementation, plus an in-memory version under `test/support/`.
4.3. Extend `test/integration/migrations.int.test.ts` with the new table and its constraints. Add `test/integration/classifications.int.test.ts`:
  - storing valid, invalid and error attempts;
  - the latest valid row wins;
  - rows are never updated.

## 5. CLI

5.1. Write `src/cli/classify.ts` with the script `classify` (`tsx --env-file-if-exists=.env src/cli/classify.ts`).
  - It finds the interaction by UUID or `external_id`, and exits with code 2 and a clear message if it is not found.
  - Without `--dry-run`, it classifies, stores the attempt and prints the result, the outcome, the model (and fallback), tokens, cost and latency.
  - With `--dry-run`, it prints the rendered system and user prompts and the token count from `countTokens`. Nothing is stored.
  - It fails with a clear message if `ANTHROPIC_API_KEY` is missing.
  - Its `main` takes injectable dependencies (client, db) so it can be tested.
5.2. Write `test/integration/classify-cli.int.test.ts`. With a mocked client and a throwaway database:
  - by `external_id` → one stored `valid` row;
  - an invalid output → one stored `invalid` row and exit code 0, because the attempt was stored;
  - an unknown ID → exit code 2 and nothing stored;
  - `--dry-run` → no row.

## 6. Docs and constitution

6.1. Update [tech-stack.md](../../tech-stack.md):
  - LLM row: structured output via `output_config.format`, plus fallbacks;
  - Languages: summaries in English;
  - data model: the `classifications` columns;
  - repository layout: `src/cli/`.
6.2. Update `README.md` with the classify command, the env vars and the dry-run. Add `TRIAGE_MODEL` and `TRIAGE_EFFORT` to `.env.example`, and say that `ANTHROPIC_API_KEY` is now used by `classify` too.

## 7. Verify and demo

7.1. Run lint, format check, type check, unit tests, build, audit and the integration tests.
7.2. Run `npm run classify -- --dry-run msg-…` (free) on one message and check the prompt size and whether the system prompt is long enough to be cached.
7.3. **Ask before the paid demo.** Then classify the 5 demo messages (requirements.md, Validation), check the stored rows in `psql`, and note the outputs, total cost and cache reads for the PR description.
7.4. Work through [validation.md](validation.md). After review, mark P03 done in [roadmap.md](../../roadmap.md), push, open the PR and ask before merging.
