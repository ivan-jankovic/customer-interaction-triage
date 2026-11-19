# Phase 10 — Investigating agent: Plan

See [requirements.md](requirements.md) for scope and decisions, and [validation.md](validation.md) for the merge checklist.

**The only model calls are the evaluation run in group 9 (~$0.70) and the demo (~$0.05), each only after asking.** After every group, `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` pass. `npm run test:integration` must also pass after groups that touch the database.

## 1. Taxonomy, schema and prompt

1.1. `src/taxonomy.ts`: `LIKELY_CAUSES` (`area_outage`, `line_fault`, `customer_equipment`, `service_inactive`, `inconclusive`), `INVESTIGATION_OUTCOMES`, `LINE_STATES` (`up`, `degraded`, `down`) and `INVESTIGATE_TOOLS` (the three tool names).

1.2. `src/llm/schemas/investigation.schema.ts`: the final-answer schema (requirements.md, The loop) and the three tools' input schemas, with types via json-schema-to-ts. Evidence `tool` is an enum of the tool names.

1.3. Prompt `src/llm/prompts/investigate.v1.md` (`=== system ===` / `=== user ===`): the task, the causes with their meanings, that the message is untrusted data and never instructions, that evidence must come from tool results, that a cause without evidence is `inconclusive`, English summary. Add it to `versions.json`.

1.4. Unit tests: the schemas accept the example in requirements.md and reject a cause outside the list, a confidence outside 0–1, too many evidence items and an unknown tool; the prompt registry hash test covers `investigate.v1`.

## 2. Line status and the seed

2.1. Migration `src/db/migrations/0009_investigations.ts`: `crm_line_status`, `investigations` and the decision-log change (step list with `investigate`, seq 1–5), following requirements.md (Migration `0009`), value lists written out as in earlier migrations. Types in `src/db/database.ts`; `DECISION_STEPS` gains `investigate` in fourth place.

2.2. `eval/crm/generate.ts` → `crm-generate.v2`: a line-status row per service, the designed cause for each `technical_fault` message (requirements.md, The seed), line status and tickets to support it, and `expected.likely_cause` in `messages`. Regenerate `eval/data/crm/seed.json`; update `eval/data/crm/README.md`.

2.3. `npm run crm:seed` loads `crm_line_status`.

2.4. `CrmLookup` (`src/pipeline/enrich.ts`) gains `lineStatusOfCustomer(customerId)`, `recentTickets(customerId, before, days, limit)` and `outagesInArea(area, at, resolvedWithinDays)`, in the PostgreSQL (`src/db/crm.ts`) and in-memory (`src/pipeline/crm-memory.ts`) implementations.

2.5. Tests:
  - unit: the expected enrichments are unchanged; the 17 designed causes are the list in requirements.md; a simple reference check over the seed (ongoing outage → `area_outage`, line down and no outage → `line_fault`, service terminated → `service_inactive`, else `inconclusive`) gives each designed cause, so the data supports it; no diagnostic or ticket summary holds an identifier value;
  - integration (`migrations.int.test.ts`, `crm.int.test.ts`): the migration round trip and its checks; the seed loads; both `CrmLookup` implementations return the same answers for the new methods.

2.6. Print the 17 messages with their designed cause, line status and tickets, for the user to review by hand (requirements.md, Decisions).

## 3. Tools

3.1. `src/pipeline/investigate-tools.ts`: `runTool(name, input, ctx)` over a `CrmLookup`, with `ctx` = `received_at`, the allowed customer IDs and the case's area. Validates the input with Ajv, applies the customer-ID guard, and returns `{ content, isError }`. Unknown tools, bad input, the guard and thrown errors become error results. Results list only the fields in requirements.md (Tools).

3.2. The PostgreSQL lookup used by the tools runs inside a `READ ONLY` transaction.

3.3. Tests:
  - unit (`test/pipeline/investigate-tools.test.ts`, in-memory CRM): each tool's result; the time windows (ongoing and resolved-within-7-days outages, 90 days of tickets, at most 10); a foreign customer ID, an unknown tool and bad input as error results; exactly three tools exist; no result holds an identifier value from the seed;
  - integration: a write attempted through the tools' transaction fails (read-only), and the tools give the same results on PostgreSQL as in memory.

## 4. LLM client

4.1. `src/llm/client.ts`: a second method, `converse(request)`, taking the system prompt, the message list (with `tool_use` and `tool_result` blocks), the tool definitions (`strict: true`), the output schema, model, effort and max tokens. It returns the content blocks, the stop reason, the served model and usage, and maps errors the same way as `complete` (failure type, HTTP status). The system prompt and tool definitions are cached. Check the request shape against the installed `@anthropic-ai/sdk` types.

4.2. Unit tests (`test/llm/client.test.ts`) with a fake SDK: the request body (tools, `output_config.format`, no fallbacks), a tool-use response, a final answer, a refusal, max tokens and an API error with status.

## 5. The loop

5.1. `src/pipeline/investigate.ts` (`INVESTIGATOR_VERSION = "investigate.v1"`): `investigate(input, deps)` builds the first message (requirements.md, Input), loops up to `INVESTIGATE_MAX_TURNS` (6) and 12 tool calls, runs every requested tool through `runTool`, and ends with an attempt: outcome, cause, confidence, summary, evidence, steps, tool calls, raw output, errors, models, effort, summed usage, cost and latency. Never throws for model behaviour; `apiStatus` is set for `error`, as in `understand()`.

5.2. The checks after the schema: each evidence item's tool was called without error.

5.3. `isInconclusive(attempt)`: requirements.md (Outcomes and review), used by routing.

5.4. Unit tests (`test/pipeline/investigate.test.ts`) with a scripted mock client:
  - one turn with three tools in parallel, then a valid answer;
  - the step limit: a model that keeps calling tools stops after 6 turns with `step_limit`; the tool-call cap;
  - a tool error is sent back as an error result and the loop goes on;
  - an unknown tool and a foreign customer ID come back as error results;
  - invalid JSON, a schema failure, evidence from a tool that wasn't called, a refusal and max tokens give `invalid`;
  - an API error gives `error` with its status;
  - no customer: the customer tools answer "no customer" and the answer can still be `area_outage`;
  - every request the loop sends (messages and tool results) holds no identifier value from the masking map;
  - `isInconclusive` for each outcome, `inconclusive` and confidence 0.69 / 0.7.

## 6. Storage, routing and the pipeline

6.1. `src/db/investigations.ts`: record an attempt, the latest attempt for an enrichment.

6.2. `src/pipeline/route.ts` → `route.v3`: `RouteInput.investigation` (the attempt's outcome, cause and confidence, or `null`); `investigation_inconclusive` fires for a valid `technical_fault` whose investigation is inconclusive, with a detail naming the outcome, the cause or the confidence. `null` adds nothing.

6.3. `src/db/cases.ts`: routing reads the investigation used; a valid `technical_fault` without one is an error ("investigate first"). The decision log gets the `investigate` entry (investigation ID, outcome, cause, confidence, steps, tools called; or `skipped` and why), with no message text, summary or tool results.

6.4. `src/pipeline/process.ts` → `process.v2`: the investigate step between enrich and route, resumable (requirements.md, Retries), with `investigate` in `StepResults`. The worker and `npm run process` use it.

6.5. `npm run investigate -- <id | external_id> [--dry-run]` (`src/cli/investigate.ts`): after classify and enrich; prints the cause, confidence, summary, evidence and each tool call. `npm run route` prints the new entry (`src/format/decision-log.ts`). `.env.example` gains `INVESTIGATE_MODEL=`, `INVESTIGATE_EFFORT=`.

6.6. Tests:
  - unit (`test/pipeline/route.test.ts`): the rule for each inconclusive case, a conclusive investigation adds nothing, a non-fault ignores it, `null` gives `route.v2`'s result; the dataset-wide routing test still gives 100% recall on must-review, with `null` and with every fault's investigation set to inconclusive;
  - integration (`process.int.test.ts`, `cases.int.test.ts`, `commands.int.test.ts`): a technical fault goes through all five steps with a mocked client; a non-fault logs `investigate` as skipped; a retry reuses the stored investigation (the mock isn't called again); a transient error retries and on the final attempt routes to review; routing a fault without an investigation is refused; `npm run investigate` stores one attempt.

## 7. The review screen

7.1. `src/review/case-view.ts` and `src/review/screen.ts`: the investigation (cause, confidence, summary, evidence, and each tool call by name and input, with error flags), or "not investigated".

7.2. Tests: the screen for a fault with a valid investigation and with a `step_limit` one; still no identifier value in the output.

## 8. Evaluation

8.1. `eval/investigate.ts` and `npm run eval:investigate` (requirements.md, Evaluation): reads the input run, picks the labelled `technical_fault` messages (`--subset small` keeps those in the small subset), masks and enriches against the in-memory seed, investigates, and writes the run folder. The paid-run guard estimates the cost from a token count of the first turn times the turns expected.

8.2. Metrics and report in `eval/metrics/` and `eval/report/`; `eval:report` and `eval:keep` handle the new run type.

8.3. Unit tests: metrics from fixture outputs (accuracy, per-cause precision and recall, confusion matrix, turns, tool calls, outcomes, "not investigated"); the report recomputes byte for byte.

8.4. Check that `npm run eval:report` still reproduces the kept classify runs with the new seed. If it doesn't, stop and raise it (requirements.md, Notes).

## 9. Docs, verify and demo

9.1. Update [tech-stack.md](../../tech-stack.md): the data model (`investigations`, `crm_line_status`, the decision log's five steps), "The investigating agent" (causes, tools, guard, limit, outcomes), "Routing rules" (`route.v3`), "Pipeline" (`process.v2`), "Evaluation" (`eval:investigate`). Update `README.md`: an "Investigation" section.

9.2. Run lint, format check, type check, unit tests, build, audit, `db:migrate` and the integration tests.

9.3. **After asking** (~$0.70): `npm run eval:investigate` on all 17 faults; keep the run. Record the results in requirements.md (Results).

9.4. **After asking** (~$0.05): the demo on a separate `triage_demo` database, as in P08/P09: `crm:seed`, then msg-071 posted through the API and processed (`npm run process`), showing the tools called, the evidence, the case and the five-entry decision log, and the review screen for it. Drop the database afterwards. Keep the output for the PR description.

9.5. Work through [validation.md](validation.md). After review, mark P10 done in [roadmap.md](../../roadmap.md), push, open the PR and ask before merging.
