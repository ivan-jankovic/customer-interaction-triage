# Phase 10 — Investigating agent: Validation

The branch `p10-investigating-agent` can be merged when every check below passes.

How each check is marked:

- **(test):** automated in Vitest.
  - Unit tests run with `npm test`.
  - Integration tests are under `test/integration/` and run with `npm run test:integration`.
- **(ci):** a step in the GitHub Actions workflow that must be green on the pull request.
- **(manual):** needs a command or human judgement.

## Checks pass

- [ ] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build` and `npm run audit` pass. **(ci)**
- [ ] `npm test` passes with no `ANTHROPIC_API_KEY` and no network; no test calls a model. **(ci)**
- [ ] `npm run test:integration` passes locally and in CI. **(ci)**

## Storage and seed

- [ ] Migration `0009` creates `crm_line_status` and `investigations` with their checks, and lets `decision_log` hold `investigate` and seq 1–5; rolling back restores the earlier state. **(test)**
- [ ] `crm-generate.v2` gives every service a line-status row, and the 17 technical faults the designed causes in requirements.md (8 `area_outage`, 1 `line_fault`, 1 `service_inactive`, 7 `inconclusive`). **(test)**
- [ ] The reference check over the seed gives each fault's designed cause, and the expected enrichments are unchanged. **(test)**
- [ ] The 17 designed causes were reviewed by hand. **(manual)**

## Tools

- [ ] Exactly three tools exist: `check_outages`, `get_line_status`, `get_recent_tickets`. **(test)**
- [ ] Each tool returns the fields and time windows in requirements.md (Tools), the same on PostgreSQL and in memory. **(test)**
- [ ] A customer ID that isn't the case's found customer or a candidate, an unknown tool and bad input each come back as an error result. **(test)**
- [ ] The tools run in a read-only transaction: a write through it fails. **(test)**
- [ ] No tool result holds an identifier value (customer number, contract number, phone, e-mail). **(test)**

## The loop

- [ ] A scripted run (three tools in one turn, then an answer) gives a `valid` attempt with cause, confidence, summary, evidence and every tool call recorded. **(test)**
- [ ] A model that keeps calling tools stops after 6 turns with outcome `step_limit`; the 12-call cap holds. **(test)**
- [ ] A tool error goes back to the model as an error result and the loop goes on. **(test)**
- [ ] Invalid JSON, a schema failure, evidence from a tool that wasn't called, a refusal and max tokens give `invalid`; an API error gives `error` with its status. **(test)**
- [ ] No request the loop sends (messages or tool results) holds an identifier value from the masking map. **(test)**
- [ ] The request uses strict tools, the investigation schema as `output_config.format`, and no fallbacks. **(test)**

## Routing and pipeline

- [ ] `investigation_inconclusive` fires for a valid `technical_fault` when the outcome isn't `valid`, the cause is `inconclusive` or the confidence is below 0.7, and never changes the team. **(test)**
- [ ] With `investigation: null`, `route.v3` gives the same result as `route.v2`. **(test)**
- [ ] The dataset-wide routing test gives 100% recall on must-review with `route.v3`. **(test)**
- [ ] A technical fault processed with a mocked client gets five decision-log entries (mask, classify, enrich, investigate, route); a non-fault's `investigate` entry says skipped and why. **(test)**
- [ ] A retry reuses the stored investigation without calling the model; a transient error retries the job, and on the final attempt the case goes to review. **(test)**
- [ ] Routing a valid technical fault with no investigation is refused. **(test)**
- [ ] `npm run investigate -- <id>` stores one attempt and prints the cause, evidence and tool calls; `--dry-run` calls no model. **(test)**
- [ ] The review screen shows the investigation, and still no identifier value. **(test)**

## Evaluation

- [ ] Metrics from fixture outputs: cause accuracy, per-cause precision and recall, confusion matrix, outcomes, turns, tool calls, "not investigated"; `eval:report` recomputes the report byte for byte. **(test)**
- [ ] `npm run eval:report` still reproduces the kept classify runs. **(manual)**
- [ ] After the user's go-ahead (~$0.70), a kept `eval:investigate` run on all 17 faults reports cause accuracy, steps and tool calls, with the per-cause numbers marked as indicative. Results recorded in requirements.md. **(manual)**

## Demo

- [ ] After the user's go-ahead (~$0.05), on a separate demo database: msg-071 processed end to end, with the tools it called, the evidence, the case and its five decision-log entries, and the review screen. The output is in the PR description. **(manual)**

## Specs updated

- [ ] [tech-stack.md](../../tech-stack.md) has `investigations`, `crm_line_status`, the five-step decision log, the agent's causes, tools, guard and limit, `route.v3`, `process.v2` and `eval:investigate`. **(manual)**
- [ ] `README.md` has an "Investigation" section. **(manual)**
- [ ] P10 is marked done in [roadmap.md](../../roadmap.md) after review. **(manual)**

## Scope checks

- [ ] The agent has no tool that writes, and the investigation never changes a case's team or removes a reason code. **(test)**
- [ ] `classify.v1`, `classify.v2` and `summary-judge.v1` are unchanged (registry hashes unchanged); `investigate.v1` is registered. **(test)**
- [ ] No injection-set run (P11), no eval in CI (P12), no web page (P13). **(manual)**
- [ ] No model call outside the evaluation run and the demo. **(manual)**
