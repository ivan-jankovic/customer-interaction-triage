# Phase 5 — Masking: Requirements

## Context

This is phase P05 in [roadmap.md](../../roadmap.md). P03 built the understanding step and P04 the evaluation harness, with a baseline in `eval/results/kept/`. Both sent the **raw** synthetic text to the model, under an explicit, temporary exception to CLAUDE.md's "Mask before the model". P05 ends that exception.

This phase builds step 2 of the pipeline in [mission.md](../../mission.md): "Masking: replaces personal data (phone numbers, e-mail addresses, account and birth numbers) with placeholders before anything is sent to a model." It serves the principle "Privacy by design". The mapping it stores is what P06's CRM lookup will use. The evaluation re-run measures what masking costs or gains against the P04 baseline.

## Scope

In scope:

- **A rule-based masker** (`src/pipeline/mask.ts`, version `mask.v1`). It recognises the seven identifier types by format (no model, no checksums) and replaces them with typed placeholders such as `[PHONE_1]`. It returns the masked text and the mapping.
- **The masking step.** `maskInteraction(id)` stores `masked_text` on the interaction and the mapping in a new `masked_identifiers` table. It runs once per interaction: running it again returns the stored result.
- **Prompt `classify.v2`.** It explains the placeholders and drops identifier extraction; nothing else changes. Its output schema has no `identifiers`. The understanding step fills `fields.identifiers` from the masking map, so the stored classification keeps its shape.
- **Classification on masked text only.** `npm run classify` masks first, then classifies `masked_text`. `--dry-run` shows the masked prompt. Nothing after the masking step gets the raw text.
- **`npm run mask -- <id | external_id>`.** It runs the masking step for one interaction and prints the raw text, the masked text and the mapping. It is free (no model) and is the before/after demo.
- **Evaluation:**
  - `npm run eval` masks each message in memory with the same masker; the classifier and the summary judge both see only masked text;
  - `run.json` records the masker version;
  - `npm run eval:compare -- <run A> <run B>` prints a comparison table.
- **Migration `0003`:** `interactions.masked_text`, `interactions.masker_version`, `interactions.masked_at`, and the `masked_identifiers` table.
- **Tests:**
  - unit tests for every identifier type and format, overlaps, repeats and non-matches;
  - a test that masks all 115 dataset and injection messages and checks that every labelled identifier is gone and mapped;
  - integration tests for the masking step and the classify flow.
- **The two paid runs:** the small subset, then the full re-run, kept and committed as the masked baseline (each only after asking).
- **Docs:**
  - [tech-stack.md](../../tech-stack.md): the Masking section (formats, placeholders, mapping table, version), the data model, and identifiers coming from masking.
  - The README.
  - The P03 masking exception is marked as ended.
  - Approving this spec approves these edits.

Out of scope (later phases):

- **Masking names and street addresses.** Rules can't find Czech and Slovak names reliably, and names aren't used for the CRM lookup. This is a known limitation, recorded in tech-stack.md and in the README later (P14).
- CRM lookup from the mapping (P06).
- The urgency issue found in the baseline (P12). `classify.v2` changes only what masking needs.
- The summary judge's 300-character `reason` limit (P04 finding). Changing the judge now would mix a judge change into the masking comparison, so `summary-judge.v1` stays.
- Queueing and the worker (P08). Masking runs when an interaction is processed: today from the CLI, later from the worker.
- Unmasking anything for people; reviewers see the summary, which contains no identifiers (P09, P13).

## Masking rules (`mask.v1`)

Values are recognised by **format only**. The dataset's identifiers have deliberately invalid checksums ([labelling guide](../../../eval/labelling-guide.md), "Identifier formats"), and real input contains typos.

| Type | Placeholder | Recognised format |
| --- | --- | --- |
| `iban` | `[IBAN_n]` | `CZ` or `SK`, 2 digits, then 20 digits, with or without spaces after every 4 characters |
| `email` | `[EMAIL_n]` | A usual e-mail address. Addresses at `merelo.example` (Merelo's own) are **not** masked. |
| `customer_number` | `[CUSTOMER_NUMBER_n]` | `MR` + 8 digits |
| `contract_number` | `[CONTRACT_NUMBER_n]` | `SML-` + 4-digit year + `-` + 5 digits |
| `birth_number` | `[BIRTH_NUMBER_n]` | 6 digits forming a plausible `YYMMDD` (month 01–12, 21–32, 51–62 or 71–82; day 01–31), then `/` and 3 or 4 digits |
| `bank_account` | `[BANK_ACCOUNT_n]` | An optional prefix of up to 6 digits and `-`, then 2–10 digits, `/` and a 4-digit bank code (anything in this shape that isn't a birth number) |
| `phone` | `[PHONE_n]` | `+420`, `+421`, `00420` or `00421` followed by 9 digits, spaces allowed; or a national 9-digit number written as one block or in groups of 3 |

Further rules:

- **Order.** Types are matched in the table's order, and a span that is already masked is never matched again, so an IBAN's digit groups can't become a phone number.
- **Boundaries.** A match never starts or ends inside a longer run of digits or letters, so `1234567890123` is not a phone number.
- **Numbering.** Placeholders are numbered per type in order of first appearance. The same value written twice gets the same placeholder. "The same" means equal after removing spaces (and ignoring case for e-mails).
- **The mapping.** Each placeholder is stored with its type, its value as first written, its normalised value, and the start and end offsets of its first occurrence in the raw text.
- **Version.** `masker_version` is stored on each interaction and in every eval run. A change to the rules is a new version (`mask.v2`); P05 doesn't re-mask stored interactions automatically.

## Data

Migration `0003`:

| Change | Columns | Rule |
| --- | --- | --- |
| `interactions` + | `masked_text text`, `masker_version text`, `masked_at timestamptz` | All null until masked, then all set together (check constraint). Never changed after that. |
| New `masked_identifiers` | `id uuid` (uuidv7), `interaction_id uuid` (foreign key), `placeholder text`, `type text`, `value text`, `normalized_value text`, `start_offset int`, `end_offset int`, `created_at timestamptz` | Unique on `(interaction_id, placeholder)`; `type` is checked against the seven types; indexed on `(type, normalized_value)` for P06's lookup |

**How a classification gets its identifiers.** The understanding step receives the masked text and the mapping. It sends only the masked text to the model, validates the output against the `classify.v2` schema (no identifiers), and then sets `fields.identifiers` from the mapping (type and value, in placeholder order). The `classifications` table and the eval's scoring are unchanged. Identifier precision and recall now measure the masker.

## Decisions

### Requirements

| Decision | Choice | Why |
| --- | --- | --- |
| What is masked | The seven identifier types; names and street addresses are not | Rules can't find names reliably; recorded as a limitation. Decided during spec review. |
| Source of identifiers | The masking map, not the model; `classify.v2` drops identifier extraction | Deterministic and exactly what P06 needs. Decided during spec review. |
| Phone formats | International (`+420`/`+421`/`00420`/`00421`) and 9-digit national | Real customers write "777 123 456"; masking too much is the safe direction. Decided during spec review. |
| Judge input | Masked text | Nothing in the eval sends raw identifiers to a model any more. Decided during spec review. |
| Checksums | Not used | The dataset's values are built to fail them, and real input has typos ([labelling guide](../../../eval/labelling-guide.md)). |
| Merelo's addresses | `@merelo.example` is not masked | Not personal data; the labelling guide doesn't count them as identifiers. |

### Plan

| Decision | Choice | Why |
| --- | --- | --- |
| When masking runs | A pipeline step before understanding, idempotent per interaction; the classify CLI calls it now, the P08 worker later | Matches tech-stack.md's pipeline; intake stays a plain store. Decided during spec review. |
| Concurrency | `update interactions set masked_text = … where id = … and masked_text is null returning id`, in the same transaction as inserting the mapping; if no row comes back, the stored result is read | Two runs at once can't store two different mappings. |
| Mapping store | A `masked_identifiers` table | Easy to query by type for P06. Decided during spec review. |
| Prompt `classify.v2` | Only what masking needs: placeholders explained, the identifiers field and its rules removed, examples masked | The re-run then measures masking, not other prompt changes. Decided during spec review. `classify.v1` stays in the registry, unchanged. |
| Existing interactions | Masked lazily when first processed; no backfill command | Masking is part of processing. Decided during spec review. |
| Comparison | `npm run eval:compare -- <A> <B>`: a Markdown table of headline metrics for both runs and the difference (overall and per language), with each run's settings; warns when the sets differ | Small, and P12 builds on it. Decided during spec review. |

### Validation

| Decision | Choice | Why |
| --- | --- | --- |
| Dataset-wide leak test | Masking all 115 dataset and injection messages must remove every labelled identifier value and map exactly the labelled identifiers. A request built for the model contains no labelled value. | Proves on real data that nothing labelled reaches a model, for free. Decided during spec review. |
| Paid runs | Subset first, then the full re-run after a second go-ahead | Decided during spec review. |
| Demo | `npm run mask` on one message per identifier type (free), plus one paid `npm run classify` on a masked message | Decided during spec review. |

## Notes

- **The P03/P04 exception ends here.** From P05 on, every model call in the pipeline and the eval gets masked text. The kept P04 baseline stays as it was (run on raw text); it is the "before" of the comparison.
- **What the comparison will and won't show.**
  - Intent was already at 100%, so a masking effect on intent can only show up as a drop.
  - Identifier scores change meaning: before they measured the model, now they measure the masker.
  - Prompt-caching savings stay similar: the system prompt is the cached part, and masking changes only the user turn.
- **Spans the masker might over-mask** (for example a 9-digit reference number). These are counted by the dataset-wide test as unexpected mappings. In the dataset there should be none; if there are, each is examined and either accepted (recorded here) or fixed with a narrower rule.
- **The pipeline's raw text is still stored** in `interactions.raw_text`, by design: intake must keep the original. Only model calls and later steps are restricted to masked text.
