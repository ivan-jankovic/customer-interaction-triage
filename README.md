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

`npm run dataset:load -- --file eval/data/injection.jsonl` loads the prompt-injection set the same way. The loader sends only the message, its channel, language and dataset id, never the labels. Field rules and limits are in the [P02 requirements](specs/phases/003-p02-intake-and-storage/requirements.md).

## Classifying a message

The understanding step makes one model call per message with structured output (prompt `classify.v1` in [src/llm/prompts/](src/llm/prompts/)). It needs `ANTHROPIC_API_KEY` in `.env`, and **each run costs money** (about $0.01 per message with the defaults).

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

Each run lands in `eval/results/<run-id>/` with `report.md` and `report.html` (intent accuracy, per-intent precision and recall, confusion matrix, field accuracy, summary scores, confidence, cost and latency, overall and per language). The format is described in [eval/results/README.md](eval/results/README.md); kept runs, including the baseline, are in [eval/results/kept/](eval/results/kept/).

## Checks

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests. No Docker, no network, never calls a model. |
| `npm run test:integration` | Tests against the Compose services (migrations, API with PostgreSQL, loader, Redis). |
| `npm run lint` | ESLint with type-aware rules. |
| `npm run format` / `format:check` | Prettier. |
| `npm run typecheck` | TypeScript 7 type check. |
| `npm run build` | Compiles `src/` to `dist/` (used by the Docker image). |
| `npm run audit` | Dependency audit (audit-ci, fails on any advisory). |

CI runs all of them on every pull request, and the integration job starts the full Compose stack, including the app image.

`git blame` skips the one-off formatting commit once you run `git config blame.ignoreRevsFile .git-blame-ignore-revs`.
