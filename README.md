# Customer Interaction Triage

A system that does the first pass over customer messages (e-mails, chats and call transcripts in Czech, Slovak and English) for Merelo, a fictional Czech internet and mobile provider: it works out what each message is about, finds the customer, routes the case to the right team, and sends it to a person whenever it is unsure. Only synthetic data is used.

The project is built spec-first: what and why in [specs/mission.md](specs/mission.md), how in [specs/tech-stack.md](specs/tech-stack.md), the order of work in [specs/roadmap.md](specs/roadmap.md), and one spec folder per phase in [specs/phases/](specs/phases/). The labelled dataset and how it was built are described in [eval/data/README.md](eval/data/README.md).

## Local setup

Requirements: Node.js 24 (see `.nvmrc`) and Docker with Compose.

```sh
npm ci
cp .env.example .env                 # then set INTAKE_API_KEY (below); ANTHROPIC_API_KEY only for the dataset scripts
openssl rand -hex 32                 # a key for INTAKE_API_KEY in .env (at least 32 characters)
docker compose up -d --wait          # PostgreSQL, Redis, migrations, and the intake API on http://localhost:3000
npm run crm:seed                     # load the mock CRM and outage list (safe to repeat, see "Enrichment")
npm run dataset:load                 # import the 100 dataset messages through the API (safe to repeat)
```

Every port is published on `127.0.0.1` only. If 5432, 6379 or 3000 is taken, start Compose with `POSTGRES_PORT=…`, `REDIS_PORT=…` or `APP_PORT=…` and change the URLs in `.env` to match. Without `INTAKE_API_KEY` in `.env`, the `app` container exits with a message and the other services still run.

To work on the API with reload instead of the container: `docker compose stop app`, then `npm run dev` (reads `.env`). `npm run db:migrate` and `npm run db:rollback` run migrations from the host.

## Intake API

All `/interactions` routes need the header `x-api-key` with the value of `INTAKE_API_KEY`.

| Route | What it does |
| --- | --- |
| `POST /interactions` | Stores a message: `channel` (`email`, `chat`, `call`) and `text` are required; `language` (`cs`, `sk`, `en`), `external_id` and `received_at` are optional. 201 when stored; 200 when the same `external_id` with the same content is already stored; 409 when it is stored with different content. |
| `GET /interactions/:id` | One stored message. |
| `GET /interactions?limit=20&before=<id>` | Newest first; pass `next_before` from the response to get the next page. |
| `GET /health` | 200 when the database answers (no key needed). |

```sh
curl -X POST http://localhost:3000/interactions \
  -H "x-api-key: $INTAKE_API_KEY" -H 'content-type: application/json' \
  -d '{"channel": "email", "language": "cs", "text": "Dobrý den, od rána mi nejde internet."}'
```

`npm run dataset:load -- --file eval/data/injection.jsonl` loads the prompt-injection set the same way. The loader sends only the message, its channel, language and dataset id, never the labels, plus each dataset message's fixed `received_at` from the mock CRM seed, so outage checks give the same answer on every reload. Field rules and limits are in the [P02 requirements](specs/phases/003-p02-intake-and-storage/requirements.md).

## Classifying a message

The understanding step makes one model call per message with structured output (prompt `classify.v2` in [src/llm/prompts/](src/llm/prompts/)). It needs `ANTHROPIC_API_KEY` in `.env`, and **each run costs money** (about $0.01 per message with the defaults).

```sh
npm run classify -- msg-001 --dry-run   # show the prompt and its token count (free), store nothing
npm run classify -- msg-001             # classify one stored interaction (by id or external_id)
```

Every attempt is stored in `classifications`, also when the output is invalid, with the model that answered, tokens, cost and latency. `TRIAGE_MODEL` (default `claude-opus-5-5`) and `TRIAGE_EFFORT` (default `low`) choose the model and effort. The model only ever sees masked text (see below).

Prompts are versioned: [versions.json](src/llm/prompts/versions.json) holds a hash of every prompt file, and a test fails if a published prompt changes. To change a prompt, add a new version.

## Masking

Before anything goes to a model, personal identifiers are replaced with typed placeholders: customer and contract numbers, phone numbers, e-mail addresses, birth numbers, bank accounts and IBANs become `[CUSTOMER_NUMBER_1]`, `[PHONE_1]` and so on. Masking is rule-based (no model) and runs once per interaction; the mapping is stored in `masked_identifiers` and is where a classification's identifiers come from. Personal names and street addresses are **not** masked: rules can't find them reliably.

```sh
npm run mask -- msg-001     # show the raw text, the masked text and the placeholders (free, no model)
```

## Enrichment

After a message is classified, the enrichment step looks up the customer in a **mock CRM** and checks a **mock list of known outages**. It is plain code, no model, and free to run.

- **Customer:** found by the masked customer number, contract number, phone or e-mail (never by birth number, bank account or IBAN). The outcome is `found`, `not_found`, `ambiguous` (the keys point at more than one customer) or `no_identifiers`.
- **Outages:** in the message's area, or the found customer's area when the message names none; of the message's service type; covering the time the message was received.

Every attempt is stored in `enrichments` with the candidates and the placeholders that matched them, the area and where it came from, and the matching outages. What an ambiguous or unknown customer means for the case is decided by the routing rules (below).

The mock CRM is generated from the dataset by code, so it matches the messages, including some deliberately not-found and ambiguous ones; see [eval/data/crm/README.md](eval/data/crm/README.md).

```sh
npm run crm:generate        # rebuild eval/data/crm/seed.json from the dataset (deterministic, no model)
npm run crm:seed            # load it into PostgreSQL, replacing the mock tables
npm run classify -- msg-011 # classify first (costs money)
npm run enrich -- msg-011   # customer, area and outages for the latest classification (free)
```

`crm:seed` refuses to replace the CRM once enrichments point at its customers; to reseed, start from a fresh database (`docker compose down -v`, then `docker compose up -d --wait`).

## Routing and cases

The routing step turns the classification and the enrichment into a **case**: the target team, whether a person must review it, and the reason codes. The rules are plain code (`route.v1` in [src/pipeline/route.ts](src/pipeline/route.ts)), no model, and free to run.

- **Team** by intent (billing, technical support, sales, retention, complaints, general); `general` when the model's output was invalid or the call failed.
- **Review** when any rule applies, with all the codes kept: invalid output or a failed call, a cancellation or complaint, confidence below 0.7, a customer not found or ambiguous, a technical fault with no account identifiers, or a CRM mismatch (a key that matched no one, or a service type the customer doesn't have).

Each interaction gets **one case**, written together with a **decision log**: one entry per step (mask, classify, enrich, route) with the IDs it read, what it produced and the version that decided. The log holds no message text and no identifier values.

```sh
npm run classify -- msg-011 # costs money
npm run enrich -- msg-011   # free
npm run route -- msg-011    # team, review flag, reason codes and the decision log (free); a second run writes nothing
```

On the kept `classify.v2` run, routing sends every message to its labelled team, catches **all 38** messages labelled must-review (recall 100%, precision 67.9%), and sends 56 of the 100 messages to review. The rules and their reasons are in the [P07 spec](specs/phases/008-p07-routing-rules-decision-log/requirements.md).

The review rate reflects the test set, not real traffic. The dataset gives every intent an equal share, so cancellations and complaints, which are always reviewed, make up a third of it. The mock CRM was also seeded with not-found and ambiguous customers on purpose. Among routine messages (all intents except cancellation and complaint), 34% go to review. The rules are conservative on purpose: a missed review costs more than an extra check. They are meant to be tuned later with reviewers' corrections (P09) and the confidence-gate comparison (P17). The breakdown is in the P07 spec, under Results.

## Evaluating

`npm run eval` classifies the labelled dataset with the same understanding step, grades each summary with a separate judge model, and writes a report. It calls paid models: it prints an estimate and asks before any call, and stops at `--max-cost` (default $3).

```sh
npm run eval -- --subset small --dry-run   # plan and cost estimate for the 18-message subset, no calls
npm run eval -- --subset small             # ~$0.20, for development
npm run eval                               # the full 100 messages, ~$0.90
npm run eval:report -- <run-id>            # recompute a run's reports from its stored outputs (free)
npm run eval:keep -- <run-id>              # move a run to eval/results/kept/ so it can be committed
npm run eval:compare -- <run A> <run B>    # two runs side by side, with the change in each metric
```

Each run lands in `eval/results/<run-id>/` with `report.md` and `report.html` (intent accuracy, per-intent precision and recall, confusion matrix, field accuracy, routing accuracy and must-review recall, summary scores, confidence, cost and latency, overall and per language). Routing is scored from the stored outputs against the mock CRM seed, without a model, so `eval:report` adds it to older runs too. The format is described in [eval/results/README.md](eval/results/README.md); kept runs, including the baseline, are in [eval/results/kept/](eval/results/kept/).

## Checks

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests. No Docker, no network, never calls a model. |
| `npm run test:integration` | Tests against the Compose services (migrations, API with PostgreSQL, loader, masking, mock CRM and enrichment, Redis). |
| `npm run lint` | ESLint with type-aware rules. |
| `npm run format` / `format:check` | Prettier. |
| `npm run typecheck` | TypeScript 7 type check. |
| `npm run build` | Compiles `src/` to `dist/` (used by the Docker image). |
| `npm run audit` | Dependency audit (audit-ci, fails on any advisory). |

CI runs all of them on every pull request, and the integration job starts the full Compose stack, including the app image.

`git blame` skips the one-off formatting commit once you run `git config blame.ignoreRevsFile .git-blame-ignore-revs`.
