# Mock CRM seed

`seed.json` is the mock CRM and outage list for Merelo (P06), built to match the [dataset](../README.md). Everything in it is fictional: customer numbers, contract numbers, phone numbers (national numbers starting with `0`) and e-mail addresses (RFC 2606 domains) follow the dataset's formats ([labelling guide](../../labelling-guide.md#identifier-formats-why-they-cannot-be-real)). It holds no names, street addresses, birth numbers, bank accounts or IBANs.

**Don't edit it by hand.** It is written by `npm run crm:generate` ([`eval/crm/generate.ts`](../../crm/generate.ts), generator `crm-generate.v1`, RNG seed `20261102`), which reads the dataset's final labels and uses no model. A unit test fails if the committed file differs from a fresh generation. Load it into PostgreSQL with `npm run crm:seed`. The schema is in [`src/db/crm-seed.ts`](../../../src/db/crm-seed.ts).

## Contents

| Part | Count | Notes |
| --- | --- | --- |
| Customers | 77 | 64 residential, 13 business; 54 with an e-mail. Includes 20 filler customers with no message, and 5 second customers that make messages ambiguous. |
| Services | 121 | 50 mobile, 45 internet, 26 TV; 13 terminated. Phones only on mobile services. |
| Tickets | 82 | 77 closed older tickets; 5 open, recent `technical_fault` tickets for customers of technical-fault messages (read by P10). |
| Outages | 15 | 8 match a technical fault, 4 are near misses, 3 are in areas no message names; 1 still ongoing. |
| Messages | 100 | A fixed `received_at` in Mon 2026-11-02 to Fri 2026-11-06, 08:00–19:59 Prague time, sent by `dataset:load`, and the expected enrichment. |

## Designed enrichment

The design lists are at the top of the generator, so they are easy to review. Each message's `design` field says in words what was set up.

| Outcome | Messages | How |
| --- | --- | --- |
| `found` | 47 | One customer holds every key in the message. In 3 of them (msg-008, msg-055, msg-074), one key is unknown to the CRM. |
| `not_found` | 5 | msg-001, msg-009, msg-031, msg-087, msg-097: their keys are left out. |
| `ambiguous` | 5 | A shared e-mail (msg-022, msg-042), a phone number that moved to another customer (msg-069), or two keys belonging to different customers (msg-014, msg-059). |
| `no_identifiers` | 43 | No customer number, contract number, phone or e-mail in the message. |

**Areas.** 35 messages name an area (source `message`). For 28 `found` messages without one, the area comes from the customer's services (source `customer`); those customers live in areas without outages, so the fallback never hits an outage by accident.

**Outages.** Of the 15 technical faults that name an area:

- 8 have an outage of their service type that was ongoing when they arrived: msg-011, 012, 018, 029, 037, 051, 056, 084;
- 4 are near misses, with an outage in their area that must not match: resolved before the message (msg-021, msg-063) or of another service type (msg-036, msg-079);
- 3 have no outage at all (msg-017, msg-071, msg-078).

An outage window never covers another message in the same area; the generator redraws it until that holds.

## Regenerating

Run `npm run crm:generate` after the dataset changes, then `npm test`. `test/pipeline/enrich-dataset.test.ts` enriches every message against the new seed and must match the expectations; if it doesn't, fix the design lists, not the expectations.
