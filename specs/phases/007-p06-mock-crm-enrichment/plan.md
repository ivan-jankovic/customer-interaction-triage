# Phase 6 — Mock CRM and enrichment: Plan

See [requirements.md](requirements.md) for scope and decisions, and [validation.md](validation.md) for the merge checklist.

**No model calls except classifying the three demo messages in group 7, and only after asking.** After every group, `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` pass. `npm run test:integration` must also pass after groups that touch the database.

## 1. Enrichment rules (pure)

1.1. Write `src/pipeline/enrich.ts` with `ENRICHER_VERSION = "enrich.v1"`, the `CrmLookup` interface and `enrich(input, crm)`:
  - `CrmLookup` has `customersByCustomerNumber`, `customersByContractNumber`, `customersByPhone` (last 9 digits), `customersByEmail`, `servicesOfCustomer` and `outagesAt(area, serviceType | null, receivedAt)`;
  - the input is `{ identifiers (masking map), area, serviceType, receivedAt }`;
  - the result is `{ outcome, customerId, candidates, unmatchedPlaceholders, area, areaSource, outageIds }`, following requirements.md (Enrichment rules).
1.2. Write a small `normalizeArea` (case and diacritics) and `phoneKey` (last 9 digits) next to it, so the seed generator and both `CrmLookup` implementations use the same helpers.
1.3. Write `src/pipeline/crm-memory.ts`: an in-memory `CrmLookup` built from a seed object.
1.4. Unit tests (`test/pipeline/enrich.test.ts`) on small hand-made fixtures:
  - each key type finds its customer, including phone with and without `+420`/`00420`, spaces, and case differences;
  - `no_identifiers` (no keys, or only birth number / bank account / IBAN);
  - `not_found`;
  - `found` with an unmatched key;
  - `ambiguous` from a shared key, and from two keys pointing at different customers;
  - a terminated service still matches;
  - outage matching: area with and without diacritics, service type known and `unknown`, window edges (`started_at` equal, `resolved_at` equal, ongoing), resolved outage not matching;
  - area fallback to the customer's service, no fallback when ambiguous or not found, and no area when the customer's services span several areas.

## 2. Seed generator and seed file

2.1. Write `eval/crm/generate.ts` with the script `crm:generate`. It uses the fixed RNG in `eval/lib/rng.ts` and the dataset's final labels to build the seed described in requirements.md (Seed file): customers, services, tickets, outages, `received_at` per message, and expectations. The choice of `not_found`, `ambiguous` and outage messages is a fixed list of message IDs at the top of the file, so it is easy to review.
2.2. Write `eval/schema/crm-seed.schema.ts` (JSON Schema, validated with Ajv) for `seed.json`.
2.3. Run it and commit `eval/data/crm/seed.json`. Add `eval/data/crm/README.md` with the counts (customers, services, tickets, outages, outcomes per type, technical faults with and without an outage) and how to regenerate.
2.4. Unit tests:
  - the generator is deterministic (two runs give byte-identical output);
  - `seed.json` matches its schema and the committed file equals a fresh generation;
  - every generated value follows the dataset formats, e-mail domains are `example.net`/`example.com`, and no generated value equals an identifier from another message;
  - tariffs and areas come from `src/company.ts`.

## 3. Dataset-wide check

3.1. Write `test/pipeline/enrich-dataset.test.ts`. For all 100 dataset messages: mask the text, run `enrich` against the in-memory CRM with the labelled area and service type and the seed's `received_at`, and compare with the message's expectation. Report mismatches with the message ID.
3.2. In the same file, check the outcome counts against requirements.md (some of each outcome; about half of the technical faults with an area have an outage), and that all injection messages enrich without errors as `not_found` or `no_identifiers`.

## 4. Storage, seeding and the enrichment step

4.1. Migration `src/db/migrations/0004_crm.ts` and `0005_enrichments.ts` (requirements.md, Data), with checks, foreign keys and indexes; add the types to `src/db/database.ts`.
4.2. Write `src/db/crm.ts`: the Kysely `CrmLookup`, and `seedCrm(db, seed)`, which in one transaction deletes the four mock tables' rows and inserts the seed. Deleting fails if enrichments reference customers or outages; then `crm:seed` says so and suggests a fresh database. (Customers are referenced by `enrichments.customer_id`; outage IDs are in jsonb and not constrained.)
4.3. Write `src/cli/crm-seed.ts` with the script `crm:seed`, printing the counts.
4.4. Change `eval/dataset/load.ts` to send each message's `received_at` from `seed.json`.
4.5. Write `src/db/enrichments.ts` with `enrichInteraction(db, interactionId)`: reads the stored masking (error if not masked) and the latest valid classification (error if none), runs `enrich` with the Kysely `CrmLookup`, and inserts an `enrichments` row.
4.6. Integration tests (`test/integration/crm.int.test.ts`, `enrichments.int.test.ts`):
  - migration round trip with `0004` and `0005`;
  - `crm:seed` loads the counts from the seed and running it twice gives the same rows;
  - the Kysely `CrmLookup` returns the same results as the in-memory one for every lookup in the seed's expectations;
  - `enrichInteraction` stores a row for found, not found, ambiguous and no identifiers, and a second call adds a second row;
  - errors when the interaction isn't masked or has no valid classification;
  - the check constraints reject `customer_id` without `found` and an unknown outcome;
  - `dataset:load` stores the seed's `received_at`.

## 5. CLI

5.1. Write `src/cli/enrich.ts` with the script `enrich`. For an ID or `external_id` it runs `enrichInteraction` and prints: the outcome, the customer (customer number, segment, services with tariff, area and status), each candidate with the placeholders that matched it, unmatched placeholders, the area and its source, and matching outages (area, service type, start, description). It prints placeholders, not identifier values.
5.2. Integration test for the CLI: a found customer with an outage, and an ambiguous case.

## 6. Docs and constitution

6.1. Update [tech-stack.md](../../tech-stack.md): the data model (mock CRM tables with their final fields, `enrichments`), and a short Enrichment section (keys, outcomes, area fallback, outage window, version).
6.2. Update `README.md`: loading the mock CRM (`crm:generate`, `crm:seed`), `npm run enrich`, and the demo order (`docker compose up`, `db:migrate`, `crm:seed`, `dataset:load`, `classify`, `enrich`).

## 7. Verify and demo

7.1. Run lint, format check, type check, unit tests, build, audit, `db:migrate` and the integration tests.
7.2. Demo on a fresh database: `crm:seed`, `dataset:load`, then, **after asking** (about $0.02 per message), `npm run classify` on three messages: a technical fault with a matching outage, one `not_found` and one `ambiguous` message. Then `npm run enrich` on each (free). Keep the output for the PR description.
7.3. Work through [validation.md](validation.md). After review, mark P06 done in [roadmap.md](../../roadmap.md), push, open the PR and ask before merging.
