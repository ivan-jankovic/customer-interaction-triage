# Phase 0 — Intents, schemas and labelled dataset: Plan

See [requirements.md](requirements.md) for scope and decisions, and [validation.md](validation.md) for the merge checklist.

Groups 1–5 cost nothing. Groups 6–8 call models and are run only after you approve each run.

## 1. Minimal tooling

1.1. Add `package.json` (npm, `"type": "module"`), with the scripts `typecheck` (`tsc --noEmit`), `test` (`vitest run`) and the `dataset:*` scripts added in later groups.
1.2. Add a strict `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`) and `.nvmrc` with the Node.js LTS version.
1.3. Install `@anthropic-ai/sdk`, `ajv`, `ajv-formats`, `json-schema-to-ts`, and as dev dependencies `typescript`, `tsx`, `vitest` and `@types/node`. Use the docs (ctx7) for current APIs. Run `npm audit` and record the result.
1.4. Add `.gitignore` (`node_modules/`, `.env`, `eval/data/.work/`) and `.env.example` with `ANTHROPIC_API_KEY=` and the model variables.
1.5. Add a placeholder test so `npm test` passes, and commit.

## 2. Fictional company and taxonomy

2.1. Propose 3–4 invented company names, check each by web search and in ARES, and ask you to pick one. Record the name, the check and its date.
2.2. Write `src/taxonomy.ts`: `INTENTS`, `URGENCY`, `TEAMS`, `INTENT_TO_TEAM`, `SERVICE_TYPES`, `IDENTIFIER_TYPES`, `REVIEW_REASONS`, `CHANNELS`, `LANGUAGES` and `REGISTERS`, as `as const` arrays with their derived types, plus the precedence order for mixed intents.
2.3. Write `src/company.ts`: the company name, the services and fictional tariff names, the identifier prefixes, and the list of served towns and districts in Czechia and Slovakia.
2.4. Tests: every intent maps to exactly one team; the precedence order lists every intent exactly once.

## 3. Labelling guide and dataset schema

3.1. Write `eval/labelling-guide.md`: the company, then each label with its definition, two or three examples (in cs, sk and en), the borderline cases (for example a complaint about a bill vs. a billing question, or a threat to cancel inside a fault report), the precedence rule, the must-review rules, the `unclear` criteria and the urgency criteria.
3.2. Write `eval/schema/labels.schema.ts` and `eval/schema/dataset-record.schema.ts` (JSON Schema `as const`, with types via json-schema-to-ts), plus `eval/schema/validate.ts` (compiled Ajv validators).
3.3. Add a rule check that schemas cannot express: `must_review` is consistent with `review_reasons`, and `expected_team` equals `INTENT_TO_TEAM[intent]`.
3.4. Tests: valid and invalid sample records against the schema and the rule check.

## 4. Planning the dataset (no model)

4.1. Write `eval/dataset/identifiers.ts`, which generates fictional identifiers from a seeded RNG: customer and contract numbers with the company prefix, e-mails on `example.com` and `example.cz`, phone numbers from the documented fictional range (look it up first; see the Notes in requirements.md), birth numbers, Czech account numbers and CZ/SK IBANs with invalid checksums. Document the formats in the labelling guide.
4.2. Write `eval/dataset/plan.ts`, which draws 100 label combinations deterministically from a fixed seed and meets the coverage targets in requirements.md (languages, channels, at least 2 per intent per language, urgency mix, about 15 ambiguous, about 5 mixed cs/sk, about 70% with identifiers, every identifier type at least 5 times). It also plans 15 injection entries across the listed tactics and languages. Output: `eval/data/.work/plan.jsonl`.
4.3. Add the script `dataset:plan`. Tests: the same seed gives the same plan; the coverage targets are met; identifiers have the expected formats and invalid checksums.
4.4. Copy the plan's coverage table into `eval/data/README.md` (draft).

## 5. Model access with guards (mocked in tests)

5.1. Write `eval/lib/llm.ts`, a thin wrapper around the Anthropic SDK: model from env, a tool-use call with a JSON Schema, token usage returned. The interface is small enough to mock.
5.2. Write `eval/lib/cost.ts`: a per-model price table (looked up when implemented, noted with its date), a cost estimate from planned calls, a running total, and a stop when the total would exceed `--max-cost`.
5.3. Write `eval/lib/run-guard.ts`: `--dry-run` prints the planned calls and the estimate, and a real run asks for confirmation on the TTY.
5.4. Tests with a mocked client: the dry run makes no calls; the run stops at the cap; usage is summed correctly.

## 6. Generation (paid: ask first)

6.1. Write `eval/prompts/generate.v1.md`. It covers the company context, the chosen labels, the channel format (an e-mail with a subject line, a chat as lines with speaker turns, a call transcript with Agent/Customer turns), the register, the language (and the mix), the identifiers to include verbatim and the area. It also says that no real company or person may be named.
6.2. Write `eval/dataset/generate.ts`. For each plan entry it makes one call, checks in code that every identifier appears verbatim and that there is no denylisted operator name, and retries a failing entry up to 2 times. It writes `eval/data/.work/generated.jsonl` and is resumable (it skips done ids).
6.3. Tests with a mocked client: a valid response is stored; a missing identifier triggers a retry; a resumed run skips done ids.
6.4. Run `--dry-run`, show you the estimate, and run it for real after your approval. Commit the generated messages.

## 7. Grading (paid: ask first)

7.1. Write `eval/prompts/grade.v1.md`. It holds the full labelling guide and the message, and nothing about the chosen labels. The output is the labels schema without identifiers.
7.2. Write `eval/dataset/grade.ts`. Both grader models label each message independently (separate calls, neither sees the other's answer). Output is validated with Ajv and retried once if invalid, otherwise marked `valid: false`. The script is resumable.
7.3. Write `eval/dataset/mismatch.ts`. It compares chosen and grader labels on the decided fields, with area normalisation, sets `review.needed`, and draws the 10-message agreement sample with a fixed seed.
7.4. Tests: a mocked grader produces stored, validated labels; invalid output becomes `valid: false` and a mismatch; area comparison ignores case and diacritics; the sample is deterministic.
7.5. Dry run, approval, real run. Commit.

## 8. Human review

8.1. Write `eval/dataset/review.ts` (`dataset:review`). It steps through every record with `review.needed` or `review.sampled` that is not yet reviewed, shows the text, the chosen labels and both graders' labels side by side (differences highlighted), and offers accept chosen, take grader A/B, edit fields, or flag for rewrite. Each decision is written immediately, so a session can be resumed.
8.2. Regeneration of flagged messages: rerun generate (next `attempt`) and grade for those ids only (paid, ask first), then review again.
8.3. Review the injection set in full with the same CLI (no grader columns).
8.4. Write the final files `eval/data/dataset.jsonl` and `eval/data/injection.jsonl` (records validated, `final` set on every record).
8.5. Tests: the review state machine with a scripted input (accept, correct, flag, resume).
8.6. Interactive step (you): run the review until no record is pending.

## 9. Statistics and docs

9.1. Write `eval/dataset/stats.ts` (`dataset:stats`). It prints counts per intent, channel, language, urgency and must-review, intent × language, and review statistics (needed, sampled, reviewed, labels changed per field, rewritten, agreement between each grader and the final labels). It rewrites the section between markers in `eval/data/README.md`.
9.2. Complete `eval/data/README.md`: the procedure (the three steps), models, prompt versions, seeds, cost of each run, and how to rebuild.
9.3. Update [tech-stack.md](../../tech-stack.md): the "Intents" heading and list are final, the teams and fields are listed, and the labelling guide is linked. (This edits the constitution; approving this spec approves the edit.)

## 10. Dataset tests and verification

10.1. Write `test/eval/dataset-files.test.ts` over the committed files, covering the schema, unique ids, coverage, completed review and the synthetic-data guard (see validation.md).
10.2. Run `npm run typecheck` and `npm test`.
10.3. Mark P00 done in [roadmap.md](../../roadmap.md) after review.
10.4. Work through [validation.md](validation.md).
