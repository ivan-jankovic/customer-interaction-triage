# Phase 5 — Masking: Plan

See [requirements.md](requirements.md) for scope and decisions, and [validation.md](validation.md) for the merge checklist.

**No model calls except the demo classification and the two eval runs in group 7, and each runs only after asking.** After every group, `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` pass. `npm run test:integration` must also pass after groups that touch the database.

## 1. The masker (pure)

1.1. Write `src/pipeline/mask.ts` with `MASKER_VERSION = "mask.v1"` and `mask(text) → { maskedText, identifiers: [{ placeholder, type, value, normalizedValue, start, end }] }`, implementing requirements.md (Masking rules): order, boundaries, numbering, repeats and the `merelo.example` exception.
1.2. Write `test/pipeline/mask.test.ts`. For each type, cover every format variant in the rules table (spaced and unspaced, `+420`/`+421`/`00420`/`00421`, national 3-3-3 and one block, IBAN grouped and ungrouped, account with and without prefix). Also cover:
  - birth number vs. bank account (a plausible date vs. not);
  - an IBAN not producing a phone number;
  - digit runs that are too long, amounts, dates and times, and postcodes not matching;
  - repeats getting the same placeholder;
  - numbering per type;
  - `info@merelo.example` staying;
  - offsets pointing at the original value;
  - text with no identifiers coming back unchanged.
1.3. Write `test/pipeline/mask-dataset.test.ts`. For all 115 dataset and injection messages:
  - every labelled identifier value is absent from `maskedText`;
  - the mapping's `(type, value)` pairs equal the labelled identifiers as a multiset;
  - no `[TYPE_n]`-shaped text was already in the message.

  Any mismatch is reported with the message ID and the span.

## 2. Storage and the masking step

2.1. Migration `src/db/migrations/0003_masking.ts` (requirements.md, Data), with check constraints and the index. Add the types to `src/db/database.ts`.
2.2. Write `src/db/masking.ts` with `maskInteraction(db, interactionId)`. It returns `{ maskedText, identifiers, maskerVersion, maskedAt, stored: "now" | "earlier" }`, using the conditional update plus inserting the mapping in one transaction, as requirements.md describes.
2.3. Integration tests (`test/integration/masking.int.test.ts`):
  - the first call stores the text and the mapping;
  - the second call returns the stored result unchanged;
  - two calls at once store one mapping;
  - the constraints reject a half-set masking and an unknown type;
  - extend the migration round trip with `0003`.

## 3. Prompt `classify.v2` and the understanding step

3.1. Write `src/llm/prompts/classify.v2.md`, a copy of v1 changed only as requirements.md says:
  - a "Placeholders" paragraph: `[TYPE_n]` stands for a masked identifier, which may be referred to but never guessed or completed;
  - the identifiers field and its formats removed;
  - examples rewritten with placeholders;
  - the summary rule mentions placeholders too.

  Add it to `versions.json`.
3.2. Write `src/llm/schemas/classification.schema.ts`:
  - `classificationOutputSchemaV2`, the model output without `fields.identifiers`;
  - the stored `Classification` type keeps `fields.identifiers`;
  - `classificationSchema` (v1) stays for old runs and records.
3.3. Change `src/pipeline/understand.ts`:
  - the input is `{ maskedText, identifiers, channel }`;
  - the default prompt is `classify.v2`;
  - the output is validated with the v2 schema, then `fields.identifiers` is set from the mapping;
  - `buildRequest` uses the masked text.
3.4. Unit tests:
  - the request contains the masked text and no identifier value;
  - the stored classification gets the mapping's identifiers in placeholder order;
  - a v2 output that still contains `identifiers` is invalid (extra field);
  - the prompt-contamination test covers v2;
  - the registry keeps v1's P03 hash.

## 4. CLI

4.1. `npm run classify` masks first (`maskInteraction`) and then classifies the masked text. It prints the masker version and the number of masked identifiers. `--dry-run` masks in memory without storing and shows the masked prompt.
4.2. Write `src/cli/mask.ts` with the script `mask`. It runs `maskInteraction` for an ID or `external_id` and prints the raw text, the masked text and a table of placeholders (placeholder, type, value), saying whether the masking is new or stored earlier.
4.3. Update `test/integration/classify-cli.int.test.ts`:
  - the model request has no raw identifier;
  - the interaction is masked once, and a second classify reuses it;
  - `--dry-run` stores no masking.

  Also add a test for the `mask` CLI.

## 5. Evaluation

5.1. Change `eval/run.ts`:
  - each message is masked in memory with `mask()`;
  - `understand` gets the masked text and mapping;
  - the judge gets the masked text;
  - `run.json` gains `masker: { version }` (`null` in old runs, and the reports show "none").
5.2. Write `eval/compare.ts` with the script `eval:compare`. `compareRuns(a, b)` reads both runs' `run.json` and `metrics.json` and renders Markdown:
  - the settings side by side (set, model, effort, prompt, judge, masker);
  - the headline metrics with the difference: valid rate, intent accuracy, macro F1, urgency, language, service type, area, identifiers P/R/exact, summary faithful and complete, personal-data share, cost per message, latency p50/p95;
  - per-language intent and urgency.

  It warns when the two runs have different message sets or dataset hashes. Output goes to stdout, or to a file with `--out`.
5.3. Tests:
  - the runner test checks that every model request (classifier and judge) has no labelled identifier value, and that `run.json` has the masker version;
  - a compare test on two fixture runs (a golden Markdown file);
  - the P04 report golden test still passes (old runs without a masker).

## 6. Docs and constitution

6.1. Update [tech-stack.md](../../tech-stack.md):
  - Masking section: formats including national phones, placeholder names, the `masked_identifiers` table, versioning, and names and addresses not masked;
  - data model: the `interactions` masking columns and `masked_identifiers`;
  - Pipeline: identifiers come from masking.
6.2. Leave P03's spec as it is, because it records what was true then. This phase's requirements and the README say the exception has ended.
6.3. Update `README.md` with a "Masking" section (what is masked, what isn't, `npm run mask`), and the eval section with `eval:compare`.

## 7. Verify, demo and paid runs

7.1. Run lint, format check, type check, unit tests, build, audit, `db:migrate` and the integration tests.
7.2. Free demo: run `npm run mask` on one dataset message per identifier type, and keep the before/after excerpts for the PR.
7.3. **Ask before the paid demo and subset run.** Run `npm run classify -- <one masked message>`, then `npm run eval -- --subset small --yes`, and check the report.
7.4. **Ask before the full run.** Run `npm run eval -- --yes` and `eval:keep`, then run `npm run eval:compare -- <P04 baseline> <masked run>`. Record the findings in requirements.md and the comparison in the PR description.
7.5. Work through [validation.md](validation.md). After review, mark P05 done in [roadmap.md](../../roadmap.md), push, open the PR and ask before merging.
