# Phase 5 — Masking: Validation

The branch `p05-masking` can be merged when every check below passes.

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

## Masker

- [ ] Every identifier type is masked in every format listed in requirements.md (Masking rules), with the right placeholder type. **(test)**
- [ ] An IBAN's digits never become a phone, a birth number is told apart from a bank account by its date, and longer digit runs, amounts, dates, times and postcodes are not masked. **(test)**
- [ ] The same value (ignoring spaces, and case for e-mails) gets the same placeholder, numbering is per type in order of appearance, and offsets point at the original value. **(test)**
- [ ] `@merelo.example` addresses are not masked. **(test)**
- [ ] For all 115 dataset and injection messages, no labelled identifier value remains in the masked text, and the mapping equals the labelled identifiers exactly (no misses, no extras). **(test)**

## Masking step and storage

- [ ] Migration `0003` adds the masking columns and `masked_identifiers` with their constraints and index. Rolling back removes them. **(test)**
- [ ] `maskInteraction` stores the masked text, masker version, time and mapping once; a second call, or two calls at once, return the same stored result without new rows. **(test)**
- [ ] The database rejects a half-set masking (for example `masked_text` without `masker_version`) and an unknown identifier type. **(test)**

## Understanding on masked text

- [ ] `classify.v2` explains placeholders, has no identifier extraction, and is otherwise the same as `classify.v1`. Both are in the registry, and v1's hash is the P03 one. **(test)** for the registry, **(manual)** for reading the diff
- [ ] The request sent to the model contains the masked text and none of the mapping's values. **(test)**
- [ ] The stored classification's `fields.identifiers` equal the mapping (type, value, in placeholder order). A model output that includes `identifiers` is invalid. **(test)**
- [ ] `npm run classify` masks before classifying and reuses an existing masking; `--dry-run` stores nothing. **(test)**
- [ ] `npm run mask -- <id>` prints the raw text, the masked text and the placeholder table. **(test)**

## Evaluation

- [ ] In an eval run with a mocked client, no request to the classifier or the judge contains a labelled identifier value, and `run.json` records `masker.version`. **(test)**
- [ ] `eval:compare` renders the settings and every headline metric with differences, overall and per language, and warns when the sets or dataset hashes differ. **(test)**, golden file
- [ ] P04's kept baseline still re-renders with `eval:report` (no masker shown as "none"). **(test)** on the fixture, **(manual)** on the kept run

## Demo and paid runs

- [ ] `npm run mask` shows before/after for one message per identifier type (free). **(manual)**
- [ ] After the user's go-ahead: one `npm run classify` on a masked message, and the small-subset eval. **(manual)**
- [ ] After a second go-ahead: the full eval with masking completes (`n = 100`) and is kept in `eval/results/kept/`. **(manual)**
- [ ] `eval:compare` between the P04 baseline and the masked run is in the PR description, and the findings are in requirements.md. **(manual)**

## Specs updated

- [ ] [tech-stack.md](../../tech-stack.md) describes the masking rules, placeholders, mapping table, versioning and the unmasked names/addresses limitation, and the data model has the new columns and table. **(manual)**
- [ ] `README.md` has a Masking section and `eval:compare`. **(manual)**
- [ ] P05 is marked done in [roadmap.md](../../roadmap.md) after review. **(manual)**

## Scope checks

- [ ] No CRM lookup (P06), no change to urgency rules in the prompt (P12), and `summary-judge.v1` is unchanged. **(test)** for the judge hash, **(manual)** otherwise
- [ ] No backfill command; stored interactions are masked when first processed. **(manual)**
