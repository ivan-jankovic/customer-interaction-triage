# Phase 0 — Intents, schemas and labelled dataset: Validation

The branch `p00-intents-schemas-labelled-dataset` can be merged when every check below passes.

**(test)** means automated in Vitest under `test/` (dataset file checks in `test/eval/dataset-files.test.ts`). **(manual)** means it needs a command or human judgement.

## Checks pass

- [ ] `npm run typecheck` passes. **(manual)**
- [ ] `npm test` passes, with no network access and no `ANTHROPIC_API_KEY` set. **(manual)**
- [ ] `npm audit` reports no high or critical vulnerabilities. **(manual)**
- [ ] No unit test calls a model: the LLM wrapper is mocked in every test that touches it. **(test)**

## Taxonomy and company

- [ ] `src/taxonomy.ts` exports exactly the six intents, three urgency levels and six teams from requirements.md. **(test)**
- [ ] Every intent maps to exactly one team, and the precedence order lists every intent once. **(test)**
- [ ] The company name's web and ARES check is recorded in `eval/labelling-guide.md`, with its date. **(manual)**

## Labelling guide

- [ ] `eval/labelling-guide.md` defines every intent, urgency level, field, must-review rule and the `unclear` criteria, each with at least one example. **(manual)**
- [ ] The guide covers the precedence rule and at least these borderlines: a complaint vs. a billing question, a cancellation threat inside a fault report, and a tariff change vs. a cancellation. **(manual)**
- [ ] The identifier formats (including the fictional phone range and its source) are documented. **(manual)**

## Dataset files

- [ ] Every record in `eval/data/dataset.jsonl` and `eval/data/injection.jsonl` passes the dataset JSON Schema and the rule check (`must_review` ↔ `review_reasons`, `expected_team` ↔ intent). **(test)**
- [ ] Ids are unique across both files. **(test)**
- [ ] `dataset.jsonl` has 100 records: 60 ±2 cs, 20 ±2 sk and 20 ±2 en. **(test)**
- [ ] Every intent appears at least twice in each language, and every channel at least 20 times. **(test)**
- [ ] Every identifier type appears at least 5 times, and every labelled identifier appears verbatim in its message's text. **(test)**
- [ ] `injection.jsonl` has 13–17 records, covering every listed tactic and all three languages. **(test)**

## Review complete

- [ ] Every record whose chosen labels and two grader labels do not all agree on the compared fields (or with an invalid grader output) has `review.reviewed = true`. **(test)**
- [ ] Exactly 10 all-agree records have `review.sampled = true`, and all of them are reviewed. **(test)**
- [ ] Every injection record is reviewed. **(test)**
- [ ] No record is still flagged for rewrite. **(test)**

## Synthetic data and safety

- [ ] No message text contains a name from the denylist of real Czech and Slovak operators (kept in `eval/lib/denylist.ts`). **(test)**
- [ ] Every e-mail address uses a reserved domain (`example.com`, `example.net`, `example.org` or `*.example`). Phone numbers, birth numbers, account numbers and IBANs match the documented fictional formats (invalid checksums where stated). **(test)**
- [ ] No `.env` file or API key is committed (`git ls-files` shows no `.env`, and `.gitignore` lists it). **(manual)**

## Cost guard

- [ ] `--dry-run` makes no model calls and prints an estimate. **(test)**
- [ ] A run stops before going over `--max-cost`. **(test)**
- [ ] `eval/data/README.md` records the tokens and cost of every real generation and grading run. **(manual)**

## Demo

- [ ] `npm run dataset:stats` prints counts per intent, channel and language (and urgency, must-review, intent × language) and the review statistics (reviewed, labels changed, rewritten, grader agreement). **(manual)**
- [ ] The same tables are in `eval/data/README.md`, unchanged after running the command again. **(manual)**

## Done when (roadmap)

- [ ] Every mismatch is reviewed (see "Review complete"). **(test)**
- [ ] The labelling guide and the dataset procedure are written down (`eval/labelling-guide.md`, `eval/data/README.md`). **(manual)**

## Specs updated

- [ ] [tech-stack.md](../../tech-stack.md) shows the final intents, teams and fields, and links the labelling guide. **(manual)**
- [ ] P00 is marked done in [roadmap.md](../../roadmap.md). **(manual)**

## Scope checks

- [ ] No ESLint or Prettier config, no `docker-compose.yml`, no `.github/workflows/` (P01). **(manual)**
- [ ] No `src/api/`, no triage classification prompt or model-output schema under `src/llm/` (P02, P03). **(manual)**
- [ ] No masking code (P05) and no CRM seed data (P06). **(manual)**
