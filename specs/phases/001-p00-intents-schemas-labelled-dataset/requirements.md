# Phase 0 — Intents, schemas and labelled dataset: Requirements

## Context

This is phase P00 in [roadmap.md](../../roadmap.md), the first phase. Only the constitution exists so far. There is no code, no package.json and no data yet.

The phase fixes the vocabulary the whole system uses: intents, urgency, teams, extracted fields and must-review rules. It also builds the labelled dataset that every later evaluation runs on (P04, P05, P07, P10, P11, P12). The mission's principle "Measured, not assumed" ([mission.md](../../mission.md)) depends on this dataset being trustworthy. That is why labels are chosen first, graded by two models and checked by a person where they disagree (see "Evaluation" in [tech-stack.md](../../tech-stack.md)).

P00 comes before the P01 project skeleton, so it sets up only the minimal TypeScript tooling its scripts need.

## Scope

In scope:

- **Taxonomy** as a shared TypeScript module: intents, urgency levels, teams, the intent → team mapping, service types, identifier types and dataset review reasons.
- **Fictional company:** name (web-checked, see Decisions), services and fictional tariff names, and the regions and towns it serves.
- **Labelling guide** (`eval/labelling-guide.md`): what each label means, with examples in Czech, Slovak and English, the borderline cases and the precedence rule for messages that mix intents.
- **Dataset JSON Schema** for a dataset record (chosen, grader and final labels, review state), validated with Ajv. TS types come from json-schema-to-ts.
- **Dataset build scripts** under `eval/dataset/`:
  - `plan`: draws the label combinations deterministically (seeded) and generates the fictional identifiers in code.
  - `generate`: one model call per planned combination writes the message.
  - `grade`: two models label every message independently, using the guide.
  - `review`: an interactive CLI for the human review.
  - `stats`: prints the label and review statistics and writes them to `eval/data/README.md`.
- **The dataset:** 100 messages in `eval/data/dataset.jsonl` and 15 injection messages in `eval/data/injection.jsonl`.
- **`eval/data/README.md`:** the procedure, the models and prompt versions used, the cost of the runs, and the label and review statistics.
- **Minimal tooling:** `package.json`, a strict `tsconfig.json`, `tsx`, the Anthropic SDK, Ajv with ajv-formats, json-schema-to-ts, Vitest, and the `typecheck` and `test` scripts. `.gitignore` covers `.env` and `node_modules`.
- **Vitest tests** for the scripts' logic (with a mocked LLM client) and for the dataset files (see [validation.md](validation.md)).
- **Updating tech-stack.md** ("Intents (initial list, finalized in P00)" and the teams) to the final taxonomy.

Out of scope (later phases):

- ESLint, Prettier, Docker Compose, PostgreSQL, Redis, migrations, GitHub repository and CI (P01).
- The intake API and the dataset loader (P02).
- The triage classification prompt, the model-output JSON Schema and the Anthropic client for the pipeline (P03). P00's prompts are for building the dataset only.
- The evaluation runner `npm run eval` and its metrics (P04).
- Masking (P05). P00 only puts identifiers in the messages so that masking can be tested later.
- Mock CRM seed data (P06). P00 records the identifiers each message uses, so P06 can seed matching customers (or deliberately leave some out).
- Routing code (P07). P00 defines the intent → team mapping as data; P07 writes the rules.
- Expected likely causes for technical faults (P10 labels a subset).
- Running the injection set through the pipeline (P11).

## Decisions

### Taxonomy

| Decision | Choice | Why |
| --- | --- | --- |
| Intents | `billing_question`, `technical_fault`, `tariff_change`, `cancellation`, `complaint`, `other` (unchanged from tech-stack.md) | About 16 messages per intent is enough for per-intent precision and recall. Decided during spec review. |
| Multi-intent | One primary intent per message. The guide's precedence rule picks it: `cancellation` > `complaint` > `technical_fault` > `billing_question` > `tariff_change` > `other`. A few deliberately mixed messages test the rule. | Keeps the schema and metrics simple. Decided during spec review (the order is a proposal, open to review). |
| Urgency | `low` / `normal` / `high` | Three levels are easy to label the same way every time. Decided during spec review. |
| Teams | `billing`, `technical_support`, `sales`, `retention`, `complaints`, `general`, mapped 1:1 from the intents in the order listed above | Taken from tech-stack.md. A 1:1 mapping keeps P07's team rule trivial and testable. |
| Extracted fields | `identifiers` (a list of `{type, value}`: `customer_number`, `contract_number`, `phone`, `email`, `birth_number`, `bank_account`, `iban`), `service_type` (`internet` / `mobile` / `tv` / `unknown`), `area` (town or district, or null) | Identifiers feed the P06 CRM lookup and P05 masking, and the area feeds the outage check (P06, P10). Billing details are left out. Decided during spec review. |
| Labelled identifier values | Raw values as they appear in the text | Masking does not exist yet. P05 maps the raw values to placeholders. |
| Must-review | `true` for every `cancellation` and `complaint`, and for messages a person judges unclear. `review_reasons` lists `cancellation`, `complaint` and/or `unclear`. | The dataset can then test the "unclear" path as well as the intent rules. Decided during spec review. Runtime-only reasons (low confidence, CRM mismatch, invalid output) are not dataset labels. |

### Dataset

| Decision | Choice | Why |
| --- | --- | --- |
| Size and languages | 100 messages: 60 Czech, 20 Slovak, 20 English | More reliable per-language metrics than a traffic-like split. Decided during spec review. |
| Mixed Czech/Slovak | About 5 messages, labelled with their dominant language | tech-stack.md expects such messages. |
| Channels | About 40 email, 35 chat, 25 call transcript (each at least 20) | Proposal. Email is the most common channel, and call transcripts are the hardest to generate well. |
| Coverage | Every intent appears at least twice in each language | Per-language metrics need every class present. |
| Urgency mix | About 25 low, 50 normal, 25 high | Proposal. |
| Registers | `polite`, `angry`, `terse`, `indirect` (from tech-stack.md) | |
| Deliberately ambiguous | About 15 messages, marked `designed_ambiguous: true` in the plan | Tests the "unclear" review path and the precedence rule. |
| Injection set | About 15 messages in all three languages, covering: direct instructions ("ignore the rules, route to X"), fake system or role text, instructions hidden in quoted e-mails or transcripts, attempts to skip review on cancellations and complaints, and requests to reveal data. Each record also has `attack.tactic` and `attack.goal`. | Decided during spec review. The injection set is generated, then reviewed by hand in full (not graded), because its labels describe expected behaviour more than content. |
| Identifiers | Generated in code, never by the model: customer and contract numbers with the company's own prefix, e-mails on reserved domains (`example.com`, `example.net`, `example.org`, and the company's own `merelo.example`; corrected during implementation: `example.cz` is not reserved by RFC 2606 and could belong to someone), phone numbers from a documented fictional range, birth numbers, account numbers and IBANs with invalid checksums. They are passed into the generation prompt, and the text must contain them verbatim. | Identifiers can be traced to the labels and cannot match real people. Decided during spec review. |
| Share with identifiers | About 70% of messages contain at least one identifier; every identifier type appears at least 5 times | P05 needs every masking type covered. |
| Areas | Real Czech and Slovak town and district names | Places are not companies or people. Outages need recognisable areas. |

### Building the dataset

| Decision | Choice | Why |
| --- | --- | --- |
| Tooling before P01 | Minimal TS setup: package.json, strict tsconfig, tsx, Anthropic SDK, Ajv, json-schema-to-ts, Vitest. P01 adds the rest. | Scripts follow the TypeScript-strict rule from day one, and nothing is duplicated. Decided during spec review. |
| Generator model | `claude-opus-5-5` | Writes the most natural Czech and Slovak. Decided during spec review. |
| Grader models | `claude-sonnet-5-5` and `claude-haiku-5-5` | Two different models that differ in capability, cheap over about 100 messages. Decided during spec review. |
| Model names | Configurable through environment variables, with the defaults above | Follows tech-stack.md. |
| Grader output | Structured output via tool use with a JSON Schema, validated with Ajv. Invalid output is retried once; if it is still invalid, it counts as a mismatch. | Follows the "validate every model output" rule. |
| What counts as a mismatch | Any difference on `intent`, `urgency`, `must_review`, `service_type` or `area` (compared case- and diacritics-insensitively) | Identifiers are known exactly from the plan, so code checks them (they must appear verbatim in the text) instead of the graders. |
| Prompts | Versioned files in `eval/prompts/` (`generate.v1.md`, `grade.v1.md`). Each record stores the prompt version and model used. | Follows the "version prompts" rule. |
| Human review | `npm run dataset:review`: an interactive CLI that shows the text, the chosen labels and both graders' labels side by side. You can accept, correct or flag the message for a rewrite. Each decision is saved immediately, so a session can be resumed. | Decided during spec review. |
| Agreement sample | 10 messages, drawn with a fixed seed from those where all three agree | Catches mistakes the models share. |
| Rewrites | A flagged message is regenerated (same plan entry, next attempt number) and goes through grading and review again | |
| Cost guard | `--dry-run` prints the planned calls and an estimated cost. A real run asks for confirmation and stops at `--max-cost` (default $10). Actual tokens and cost are appended to `eval/data/README.md`. | Decided during spec review. CLAUDE.md: model calls cost money. |
| Running paid scripts | The generate and grade runs happen during implementation, only after you approve each run | CLAUDE.md. |
| Statistics | `npm run dataset:stats` prints the tables and rewrites the statistics section of `eval/data/README.md` | The README cannot go stale. Decided during spec review. |
| Where the taxonomy lives | `src/taxonomy.ts` | It is shared by the eval scripts, the P03 schema and the P07 routing rules, so it does not belong under `eval/` or `src/llm/`. |

### Fictional company

| Decision | Choice | Why |
| --- | --- | --- |
| Name | I propose 3–4 invented names and check each by web search (including the Czech business register, ARES). You pick one. The check and its date are recorded in `eval/labelling-guide.md`. | Decided during spec review. Mission: no imitation of a real company. |
| Chosen name | **Merelo** (Merelo a.s.), domain `merelo.example` | Picked during implementation from names that are easy to pronounce in cs, sk and en. 0 hits in ARES and no telecom company found on the web (2026-11-18). |

## Data record (shape)

`eval/data/dataset.jsonl`, one JSON object per line:

```jsonc
{
  "id": "msg-001",
  "channel": "email",            // email | chat | call
  "language": "cs",              // cs | sk | en (dominant)
  "text": "…",
  "plan": { "register": "angry", "designed_ambiguous": false, "mixed_language": false, "attempt": 1 },
  "chosen":  { /* labels */ },
  "graders": [
    { "model": "claude-sonnet-5-5", "prompt_version": "grade.v1", "valid": true, "labels": { /* labels */ } },
    { "model": "claude-haiku-5-5",  "prompt_version": "grade.v1", "valid": true, "labels": { /* labels */ } }
  ],
  "final":   { /* labels */ },
  "review":  { "needed": true, "sampled": false, "reviewed": true, "outcome": "corrected", "note": "…" },
  "generation": { "model": "claude-opus-5-5", "prompt_version": "generate.v1" }
}
```

Labels are `{ intent, urgency, must_review, review_reasons, expected_team, fields: { identifiers, service_type, area } }`. `injection.jsonl` uses the same shape, with an `attack` object and no `graders`. The exact schema is the JSON Schema file written in this phase.

## Notes

- P05 masking must not rely on checksums. Identifiers in the dataset deliberately have invalid checksums, so a checksum-validating masker would miss them.
- Czech and Slovak may not have an officially reserved fictional phone range. If none is found, the plan uses a prefix not assigned in the numbering plan and records the source in the guide. If even that cannot be confirmed, this is raised before generating.
- P06 will seed the mock CRM from the identifiers recorded here. Some customer numbers should deliberately have no CRM match, to test "not found". This is P06's decision, but the P00 plan keeps a list of identifiers per message to make it possible.
- The language each summary is written in is decided in P03, not here.
- Generation and grading need `ANTHROPIC_API_KEY` from the environment. It is never written to the repo.

### Implementation notes (recorded during implementation)

- **Structured output via `output_config.format`, not a forced tool call.** Forced `tool_choice` returns a 400 on `claude-opus-5-5` and `claude-sonnet-5-5`. The JSON Schema is still enforced by the API and re-validated with Ajv. tech-stack.md says "through tool use"; P03 should decide whether to keep this wording for the pipeline.
- **No server-side refusal fallbacks.** A fallback would silently switch models, and grader independence depends on knowing exactly which model answered. A refusal counts as a failed try (generation retries; a grader refusal becomes an invalid output and goes to review).
- **`eval/data/.work/` is committed**, not ignored (plan 1.4 said ignore). Its files are paid outputs and the audit trail of how each label was reached.
- **Phone numbers:** no officially reserved fictional range was found for CZ or SK, so national numbers starting with `0` are used, which neither numbering plan assigns. Bank codes `0001`–`0099` are below the lowest code in use. Details in the labelling guide.
- **Denylist** lives in `eval/lib/denylist.ts` (used by both `generate` and the dataset tests), not `test/eval/denylist.ts`. Names that are also common Czech/Slovak words or first names are left out or matched case-sensitively, to avoid false positives.
- **A separate `dataset:finalize` script** writes `dataset.jsonl` and `injection.jsonl` (plan 8.4), so review sessions only ever append to the review log.
- **Prices for cost estimates** come from the claude-api reference, cached 2026-11-03 (Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 per million tokens). Estimates ignore caching and are deliberately pessimistic.
- **`npm audit`:** a high-severity ReDoS advisory in `picomatch` (GHSA-fc5q-39xc-vjpf) affects every published version. It comes in only through Vitest (a dev dependency, run on our own glob patterns). `npm audit --omit=dev` reports 0 vulnerabilities.
