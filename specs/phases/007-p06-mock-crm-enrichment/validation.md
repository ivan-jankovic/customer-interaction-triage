# Phase 6 — Mock CRM and enrichment: Validation

The branch `p06-mock-crm-enrichment` can be merged when every check below passes.

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

## Enrichment rules

- [ ] Each of the four keys (customer number, contract number, phone, e-mail) finds its customer; phones match with and without `+420`/`+421`/`00420`, with or without spaces; customer numbers and e-mails match ignoring case. **(test)**
- [ ] Birth numbers, bank accounts and IBANs are never used for lookup: a message with only those is `no_identifiers`. **(test)**
- [ ] `not_found` when no key matches; `found` with the unmatched keys listed when exactly one customer matches; `ambiguous` both for a key shared by two customers and for two keys pointing at different customers. **(test)**
- [ ] A terminated service still matches its customer. **(test)**
- [ ] An outage matches only in the same area (ignoring case and diacritics), of the classified service type (any type when `unknown`), when `started_at <= received_at < resolved_at` or it is ongoing; a resolved outage does not match. **(test)**
- [ ] With no classified area, the found customer's service area is used and recorded as `customer`; no fallback for `not_found` or `ambiguous`, or when the customer's services are in several areas. **(test)**

## Seed

- [ ] `npm run crm:generate` is deterministic, and the committed `eval/data/crm/seed.json` equals a fresh generation and matches its schema. **(test)**
- [ ] Generated values follow the dataset formats, use only the RFC 2606 e-mail domains (`example.com`, `example.net`, `example.org`) and national phone numbers starting with `0`, take tariffs and areas from `src/company.ts`, and don't collide with another message's identifiers. **(test)**
- [ ] The seed holds no personal names, birth numbers, bank accounts or IBANs. **(test)**
- [ ] For all 100 dataset messages, enrichment with the labelled area and service type equals the expectation in `seed.json`. **(test)**
- [ ] The dataset has at least 3 messages each of `not_found` and `ambiguous`, some `found` with an unmatched key, and 6–9 of the 15 technical faults with an area have a matching outage, with at least one near miss (resolved, or another service type). **(test)**
- [ ] All injection messages enrich without errors, as `not_found` or `no_identifiers`. **(test)**
- [ ] `eval/data/crm/README.md` lists the seed counts and how to regenerate it. **(manual)**

## Storage and the enrichment step

- [ ] Migrations `0004` and `0005` create the four mock tables and `enrichments` with their constraints and indexes; rolling back removes them. **(test)**
- [ ] `crm:seed` loads the seed's counts, and running it twice leaves the same rows. **(test)**
- [ ] The PostgreSQL `CrmLookup` gives the same results as the in-memory one for the seed's expectations. **(test)**
- [ ] `enrichInteraction` stores one new row per call with outcome, candidates, unmatched placeholders, area, area source, outage IDs, classification ID and `enrich.v1`. **(test)**
- [ ] It fails clearly when the interaction is not masked or has no valid classification, and stores nothing. **(test)**
- [ ] The database rejects `customer_id` set without `found`, `found` without `customer_id`, an unknown outcome, and `area_source` without `area`. **(test)**
- [ ] `dataset:load` stores each message's `received_at` from the seed. **(test)**

## CLI and demo

- [ ] `npm run enrich -- <id>` prints the outcome, customer and services, candidates with their placeholders, unmatched placeholders, area and source, and matching outages, and prints no identifier value. **(test)**
- [ ] On a fresh database after `crm:seed` and `dataset:load`, and after the user's go-ahead for three `classify` calls: `npm run enrich` shows a technical fault with its outage, a `not_found` and an `ambiguous` message. The output is in the PR description. **(manual)**

## Specs updated

- [ ] [tech-stack.md](../../tech-stack.md) has the final mock CRM and `enrichments` fields and an Enrichment section. **(manual)**
- [ ] `README.md` explains `crm:generate`, `crm:seed`, `enrich` and the demo order. **(manual)**
- [ ] P06 is marked done in [roadmap.md](../../roadmap.md) after review. **(manual)**

## Scope checks

- [ ] No routing, review reasons or team assignment (P07); no queue or worker (P08); no line status (P10). **(manual)**
- [ ] `npm run eval`, the prompts and `summary-judge.v1` are unchanged (registry hashes unchanged). **(test)** for the hashes, **(manual)** otherwise
- [ ] No model call outside the three demo classifications. **(manual)**
