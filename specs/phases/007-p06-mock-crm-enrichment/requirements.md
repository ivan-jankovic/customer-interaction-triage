# Phase 6 — Mock CRM and enrichment: Requirements

## Context

This is phase P06 in [roadmap.md](../../roadmap.md). P02 stores interactions, P03 classifies them, and P05 masks them and stores the mapping of placeholders to identifier values in `masked_identifiers`, indexed by type and normalised value "for P06's lookup". Nothing yet knows who the customer is or whether a known outage explains the message.

This phase builds step 4 of the pipeline in [mission.md](../../mission.md): "Enrichment: looks up the customer in a mock CRM and checks a mock list of known outages." It gives P07's routing two of its review reasons ("customer not found or ambiguous", "CRM mismatch") and gives P10's agent the data its read-only tools will query. It serves the principles "Auditable" (every lookup is stored with what matched) and "Privacy by design" (enrichment is code, no model sees CRM data or raw identifiers).

## Scope

In scope:

- **Mock CRM and outage tables** (migration `0004`): `crm_customers`, `crm_services`, `crm_tickets`, `outages` (see Data).
- **A deterministic seed generator** (`npm run crm:generate`, no model). It reads `eval/data/dataset.jsonl` and writes `eval/data/crm/seed.json`: customers, services, tickets and outages, a fixed `received_at` for every dataset message, and the **expected enrichment** of every dataset message.
- **`npm run crm:seed`**: loads `seed.json` into PostgreSQL idempotently (the four mock tables are replaced as a whole).
- **`dataset:load` sends each message's fixed `received_at`** from `seed.json`, so outage windows give the same answer on every reload.
- **The enrichment step** (`src/pipeline/enrich.ts`, version `enrich.v1`):
  - customer lookup from the masking map (customer number, contract number, phone, e-mail), with the outcome `found`, `not_found`, `ambiguous` or `no_identifiers`;
  - outage check by area and service type at the interaction's `received_at`.
- **Storage** (migration `0005`): an `enrichments` table, one row per attempt, never updated.
- **`npm run enrich -- <id | external_id>`**: enriches one interaction from its stored masking and latest valid classification (free, no model) and prints the result.
- **Tests:**
  - unit tests for the lookup and outage rules, including "not found" and "ambiguous";
  - a dataset-wide unit test: every dataset message's enrichment equals the expectation in `seed.json`;
  - integration tests for the migrations, the seed loader, the enrichment step and the CLI.
- **Docs:** [tech-stack.md](../../tech-stack.md) (data model, an Enrichment section) and the README. Approving this spec approves these edits.

Out of scope (later phases):

- Turning enrichment results into review reasons or a team (P07). P06 records facts ("two customers matched"); P07 decides what they mean.
- Line status and the agent's tools (P10). Tickets are seeded now, because the roadmap asks for CRM data "seeded to match the dataset", but nothing reads them in P06.
- Running enrichment from a queue worker (P08). Today it runs from the CLI.
- Enrichment metrics in `npm run eval` (P07 adds routing accuracy, which depends on enrichment). **P06 makes no model calls** apart from classifying three messages for the demo, after asking.
- Matching by personal name or street address. Neither is masked or labelled, and the CRM stores neither (see Notes).

## Enrichment rules (`enrich.v1`)

### Customer lookup

- **Keys.** Only the four direct account keys are looked up: `customer_number`, `contract_number`, `phone`, `email`. Birth numbers, bank accounts and IBANs are not used and are not stored in the CRM.
- **Matching.**
  - `customer_number`: equal to `crm_customers.customer_number` after removing spaces, ignoring case.
  - `contract_number`: equal to `crm_services.contract_number`, ignoring case.
  - `email`: equal to `crm_customers.email`, ignoring case.
  - `phone`: the **last 9 digits** equal those of `crm_services.phone` (stored as `+420…` / `+421…`). The masker's normalised value keeps `+420` when it was written and drops it when it wasn't, so comparing the national part is what makes "777 123 456" and "+420 777 123 456" the same number.
  - Terminated services still match: a customer writing about an old contract is still that customer.
- **Outcome.** Each identifier yields zero or more customers.
  - `no_identifiers`: the masking map has none of the four key types.
  - `not_found`: there are keys, and none matches.
  - `found`: the matches point at **exactly one** customer. Keys that matched nothing are listed as unmatched (for example a new e-mail address); P07 decides whether that matters.
  - `ambiguous`: the matches point at **more than one** customer, either because one key matches several (a shared e-mail) or because two keys point at different customers.
- **Recorded.** Every candidate customer with the placeholders that matched it, and the placeholders that matched nothing. Values are not copied into the enrichment row; they are already in `masked_identifiers`.

### Outage check

- **Area.** The area from the latest valid classification. If it has none and the outcome is `found`, the area of the customer's services is used: those of the classified `service_type` when it is known and the customer has any, otherwise all of them, with active services preferred over terminated ones. It is used only when all of those services are in one area; otherwise no area is used. The source is recorded (`message`, `customer` or none).
- **Area comparison** ignores case and diacritics, as the [labelling guide](../../../eval/labelling-guide.md) does ("Ostrava-Poruba" = "ostrava-poruba"). It is otherwise exact: "Brno" does not match "Brno-Žabovřesky" (see Notes).
- **Service type.** When the classification's `service_type` is `internet`, `mobile` or `tv`, only outages of that type match; when it is `unknown`, outages of any type match.
- **Time.** An outage matches when `started_at <= received_at` and (`resolved_at` is null or `received_at < resolved_at`).
- **Recorded.** The area used, its source, and the IDs of all matching outages (zero or more).

## Data

### Migration `0004`: mock CRM

| Table | Columns | Rules |
| --- | --- | --- |
| `crm_customers` | `id uuid`, `customer_number text`, `email text` (nullable), `segment text` (`residential` \| `business`), `created_at timestamptz` | `customer_number` unique (upper case, no spaces). `email` stored lower case, **not** unique (a shared family address is one way to be ambiguous); indexed. |
| `crm_services` | `id uuid`, `customer_id uuid` (FK), `service_type text` (`internet` \| `mobile` \| `tv`), `tariff text` (from `SERVICES` in `src/company.ts`), `contract_number text`, `phone text` (nullable, mobile only, `+420…`/`+421…`), `area text` (from `AREAS`), `status text` (`active` \| `terminated`), `started_at timestamptz` | `contract_number` unique; index on the last 9 digits of `phone`. |
| `crm_tickets` | `id uuid`, `customer_id uuid` (FK), `service_id uuid` (FK, nullable), `category text` (an intent), `summary text` (English, from fixed templates, no personal data), `opened_at timestamptz`, `closed_at timestamptz` (nullable) | Read by P10. |
| `outages` | `id uuid`, `area text`, `service_type text`, `description text` (English), `started_at timestamptz`, `resolved_at timestamptz` (nullable) | `resolved_at > started_at` when set; indexed on `area`. |

Seed IDs are fixed UUIDs written into `seed.json`, so the expectations can name them.

### Migration `0005`: `enrichments`

One row per attempt, never updated; the current enrichment is the latest row.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` (uuidv7) | |
| `interaction_id` | `uuid` FK | |
| `classification_id` | `uuid` FK, nullable | The classification whose area and service type were used |
| `enricher_version` | `text` | `enrich.v1` |
| `outcome` | `text` | `found` \| `not_found` \| `ambiguous` \| `no_identifiers` (checked) |
| `customer_id` | `uuid` FK, nullable | Set exactly when `outcome = 'found'` (check constraint) |
| `candidates` | `jsonb` | `[{ customer_id, placeholders: ["[PHONE_1]", …] }]` |
| `unmatched_placeholders` | `jsonb` | `["[EMAIL_1]", …]` |
| `area` | `text`, nullable | |
| `area_source` | `text`, nullable | `message` \| `customer`; null exactly when `area` is null |
| `outage_ids` | `jsonb` | `["<uuid>", …]` |
| `created_at` | `timestamptz` | |

### Seed file (`eval/data/crm/seed.json`)

Generated, committed, and never edited by hand (the generator is the source). It holds:

- **Customers and services** for the dataset's lookup identifiers:
  - Most messages with at least one key get one customer whose records match every key in the message.
  - **About 5 messages are `not_found`**: their keys are left out of the CRM.
  - **About 5 messages are `ambiguous`**: either a key is shared with a second customer (a family e-mail, a phone moved to another customer) or two of the message's keys belong to different customers.
  - **A few messages have one unmatched key** but are still `found` (for example an e-mail the CRM doesn't know).
  - **About 20 filler customers** with no message, so the CRM is not a one-to-one copy of the dataset.
  - Areas follow the message's labelled area where it has one.
- **Tickets:** 0–3 per customer from fixed English templates; some customers of `technical_fault` messages get a recent related ticket, for P10.
- **Outages:** of the 15 `technical_fault` messages that name an area, **about half** get an ongoing outage of the right service type covering their `received_at`. The rest get either nothing or a near miss: a resolved outage in the same area, or an outage of another service type. A few outages are in areas no message names.
- **`received_at`** for every dataset message, spread over a fixed demo week (2026-11-02 to 2026-11-06, Prague time).
- **Expectations:** for every dataset message, the expected `outcome`, `customer_id`, `area`, `area_source` and `outage_ids`, computed with the message's **labelled** area and service type.

Synthetic values (customer numbers, phones, e-mails, contract numbers) that the generator invents for filler customers and second customers follow the dataset's formats (with invalid checksums, as the [labelling guide](../../../eval/labelling-guide.md) requires) and are made by the same functions (`eval/dataset/identifiers.ts`): RFC 2606 e-mail domains, national phone numbers starting with `0`.

## Decisions

### Requirements

| Decision | Choice | Why |
| --- | --- | --- |
| Seed source | A deterministic generator writes a curated `seed.json` from the dataset, with chosen `not_found` and `ambiguous` cases and the expected outcome per message | The dataset then exercises every path, and the expectations are testable. Decided during spec review. |
| Lookup keys and conflicts | Customer number, contract number, phone, e-mail; one distinct customer = found, none = not found, several = ambiguous | Birth numbers and payment data are not account keys, and the mock CRM shouldn't hold them. Keeping conflicts visible gives P07 its "ambiguous" and "mismatch" reasons. Decided during spec review. |
| Outage area | The classified area, else the found customer's service area; service type must match when known | A customer who doesn't name a town can still be told about an outage at home. Decided during spec review. |
| CRM depth | Customers, services, tickets and outages; line status left to P10 | The four tables named in tech-stack.md; P10 owns the line-status tool. Decided during spec review. |
| Outage time | `started_at`/`resolved_at` window checked against `received_at` | Replaying old messages gives the right answer. Decided during spec review. |
| Outage coverage | About half of the technical faults with an area get a matching outage | Gives P10 both "known outage" and "investigate further" cases. Decided during spec review. |
| Stable `received_at` | Fixed per message in `seed.json`, sent by `dataset:load` | Outage windows then give the same answer on every reload. Decided during spec review. |
| Personal names in the CRM | None stored | Not needed for the lookup, not masked, and fewer personal details in the mock data. |

### Plan

| Decision | Choice | Why |
| --- | --- | --- |
| Storage | An `enrichments` table, one row per attempt, never updated | Auditable like `classifications`; P07 reads it. Decided during spec review. |
| Seeding | `crm:generate` writes `seed.json`; `crm:seed` loads it, replacing the mock tables; migrations hold schema only | Reseeding is one command; data stays out of migrations. Decided during spec review. |
| Trigger | A separate `npm run enrich`, which needs a stored masking and a valid classification; `classify` unchanged | Free to run, and the CLIs aren't coupled before P08 builds the real pipeline. Decided during spec review. |
| Code shape | Pure `enrich(input, crm)` in `src/pipeline/enrich.ts` against a small `CrmLookup` interface; a Kysely implementation in `src/db/crm.ts` and an in-memory one built from `seed.json` | The dataset-wide test runs without a database, and both implementations are checked against the same expectations. |
| Phone comparison | Last 9 digits | The masker keeps or drops the country prefix as written. |

### Validation

| Decision | Choice | Why |
| --- | --- | --- |
| Dataset-wide check | A unit test enriches all 100 dataset messages (masked, labelled area and service type) against the in-memory CRM and compares with the expectations; an integration test does the same for a sample through PostgreSQL | Proves the seed and the rules agree, for free. Decided during spec review. |
| Evaluation | No eval changes and no paid run in P06 | Enrichment is deterministic code; P07 adds routing metrics. Decided during spec review. |

## Notes

- **`dataset:load` changes** (P02): it now sends `received_at`. Its tests change accordingly. Interactions already loaded keep their old `received_at`; the demo reloads into a fresh database.
- **Injection messages** (`injection.jsonl`) are not seeded: their keys find nothing, so they come out as `not_found` or `no_identifiers`. A test checks that they enrich without errors.
- **The area depends on the model.** At runtime the area comes from the classification, so a model mistake in the area changes the outage result. The dataset-wide test uses labelled areas to test the rules; the model's area accuracy (99% in P05) is measured by the eval.
- **Known limitation:** areas are compared exactly (apart from case and diacritics), so a message saying "Brno" doesn't match an outage in "Brno-Žabovřesky", and Czech declined forms aren't handled (the prompt already asks for the nominative form).
- **No model sees CRM data in P06.** When P10's agent reads it, tool results must not contain raw identifiers; the CRM holds no names and the agent will get customer IDs.

## Implementation notes

- **Seed schema location.** The plan put the schema in `eval/schema/`; it is in `src/db/crm-seed.ts`, because `npm run crm:seed` (app code) reads and validates the file, and `src/` doesn't import from `eval/`.
- **One lookup method.** `CrmLookup` has a single `customersByKey(type, key)` instead of one method per key type; both implementations compare keys with the same `lookupKey`.
- **E-mail domains.** The spec said `example.net`/`example.com`; the generator reuses the dataset's identifier functions, which also use `example.org` (all three are reserved by RFC 2606).
- **Area fallback wording.** The rule was clarified while writing the tests (see "Outage check"): services of the classified type when the customer has any, otherwise all, active ones preferred, and only when they share one area.

## Results (recorded during implementation)

- **Seed:** 77 customers, 121 services, 82 tickets, 15 outages. Of the 100 dataset messages, 47 are `found` (3 with an unknown key), 5 `not_found`, 5 `ambiguous` and 43 `no_identifiers`. 8 of the 15 technical faults with an area have a matching outage, and 4 have a near miss. Details are in [`eval/data/crm/README.md`](../../../eval/data/crm/README.md).
- **The rules agree with the design** for all 100 messages, both in memory (unit test) and through PostgreSQL (integration test). The PostgreSQL lookup gives the same answer as the in-memory one for every key, customer and outage window in the seed.
- **Demo** (a separate `triage_demo` database, dropped afterwards; the development database was not touched): after `crm:seed` and `dataset:load`, three paid `classify` calls ($0.034 in total), then `enrich`:
  - msg-011: `found` by `[CUSTOMER_NUMBER_1]`, area Opava from the message, one ongoing mobile outage;
  - msg-097: `not_found`, `[CONTRACT_NUMBER_1]` not in the CRM, no area;
  - msg-022: `ambiguous`, two customers matched by `[EMAIL_1]`, no area.

  The model's area and service type equalled the labels for all three, so the results equal the seed's expectations.
- **Finding for P07: tariffs are random.** The generator picks each service's tariff at random from `src/company.ts`, so it often differs from the tariff a message names (msg-011 says "Merelo Mobil S"; the CRM has "Merelo Data Only 50"). This doesn't affect P06, which never compares tariffs. If P07's "CRM mismatch" rule compares tariffs or service details, the generator must first take them from the messages (a new generator version).
