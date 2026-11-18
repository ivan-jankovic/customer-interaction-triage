# Phase 2 — Intake and storage: Requirements

## Context

This is phase P02 in [roadmap.md](../../roadmap.md). P01 left a project skeleton: lint, format, type check and tests in CI, PostgreSQL and Redis in Docker Compose, a Kysely migrator with an empty baseline migration, and `src/config.ts`, `src/db/` and `src/redis.ts`. There is no HTTP server, no table and no app container yet.

P02 builds step 1 of the pipeline in [mission.md](../../mission.md) ("Intake: receives a message through an API, stores it"): a Fastify API that validates and stores an interaction, and a loader that imports the labelled dataset through that API. Every later phase reads interactions from this table. Queueing the stored message is step 1 too, but it belongs to P08 (see Out of scope).

## Scope

In scope:

- **The `interactions` table**, with one migration (columns under Data).
- **A Fastify API** in `src/api/`:
  - `POST /interactions` validates and stores an interaction.
  - `GET /interactions/:id` returns one interaction.
  - `GET /interactions` returns a paged list, newest first.
  - `GET /health` checks the database connection.
- **A static API key** (`INTAKE_API_KEY`), required on every `/interactions` route and not on `/health`.
- **Idempotent intake** on an optional, client-supplied `external_id`.
- **The app in Docker Compose**:
  - A multi-stage `Dockerfile` that compiles TypeScript to `dist/`.
  - A one-shot `migrate` service.
  - An `app` service with a healthcheck on `/health`.
  - `docker compose up` starts the whole stack.
- **A dataset loader** (`npm run dataset:load`). It reads `eval/data/dataset.jsonl` by default, or another file given with `--file` (for example the injection set), and posts each message to the running API over HTTP.
- **Unit tests** for the routes (`fastify.inject` with an in-memory store) and for the new configuration.
- **Integration tests** against PostgreSQL: the routes with the real store, the migration round trip with the new table, and the loader on a few records.
- **CI, Dependabot and docs**:
  - The CI integration job builds the image and starts the full stack.
  - Dependabot also watches the `Dockerfile`.
  - `.env.example`, `README.md` and [tech-stack.md](../../tech-stack.md) (the `interactions` columns) are updated. Approving this spec approves these edits.

Out of scope (later phases):

- Enqueueing the stored message, and the outbox or sweep (P08). In P02, a stored interaction just stays `received`.
- Statuses other than `received` (P08 adds the processing statuses).
- The `masked_text` column and masking (P05).
- Detecting the language in code, or filling a missing language (P03 can report it).
- Any classification, case or CRM table (P03 and later).
- Rate limiting, TLS and user accounts. The API is local only and there is no hosted deployment ([tech-stack.md](../../tech-stack.md), "Local setup").

## Data

### Table `interactions`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | Primary key, default `uuidv7()`. This function is built into PostgreSQL 18. The IDs are time-ordered, so the list can page by `id`. |
| `external_id` | `text`, nullable | Unique when set. The caller's own ID; the loader sends the dataset ID (`msg-001`, `inj-001`). |
| `channel` | `text` | `email`, `chat` or `call`, enforced by a check constraint. |
| `language` | `text`, nullable | `cs`, `sk` or `en` (check constraint); null when the caller does not know it. |
| `raw_text` | `text` | Not null. Stored exactly as received. |
| `received_at` | `timestamptz` | When the message reached the provider. Taken from the request if given, otherwise the time of intake. |
| `status` | `text` | Default `received`; the check constraint allows only `received` for now. |
| `created_at` | `timestamptz` | Default `now()`. |

Labels from the dataset (intent, urgency and so on) never enter this table. They stay in `eval/data/`, so the pipeline cannot read the answers it is evaluated on.

### Request: `POST /interactions`

```json
{ "external_id": "msg-001", "channel": "chat", "language": "cs", "text": "…", "received_at": "2026-11-18T09:30:00+01:00" }
```

- `channel` and `text` are required. `external_id`, `language` and `received_at` are optional.
- `text` must be 1–20,000 characters and contain at least one non-whitespace character.
- `external_id` must be 1–100 characters.
- `received_at` must be an ISO 8601 date-time with a time zone.
- Unknown fields are rejected (400), not silently dropped.

### Responses

| Case | Status | Body |
| --- | --- | --- |
| Created | `201`, with a `Location` header | The stored interaction |
| Same `external_id`, same `channel`, `language` and `text` | `200` | The existing interaction, unchanged |
| Same `external_id`, different content | `409` | An error naming the conflicting `external_id` |
| Invalid body, query or ID format | `400` | Fastify's error, with the failing field |
| Missing or wrong API key | `401` | An error without details |
| Unknown ID | `404` | An error |

- **Response shape.** Each interaction is returned as `{ id, external_id, channel, language, text, received_at, status, created_at }`.
- **List.** `GET /interactions?limit=20&before=<id>` returns `{ items, next_before }`.
  - `limit` is 1–100 and defaults to 20.
  - `next_before` is the last item's `id`, or `null` on the last page.

## Decisions

### Requirements

| Decision | Choice | Why |
| --- | --- | --- |
| Deduplication | Optional `external_id`, unique in the database. A repeat with the same content returns the existing row (200); a repeat with different content is a conflict (409). | The loader can run any number of times, and a client that retries cannot create duplicates. Decided during spec review (the 409 rule is Claude's addition). |
| Language | Optional and nullable; stored when given | Real channels often don't know the language. The loader sends the dataset's language, and evaluation uses the dataset's language anyway. Decided during spec review. |
| Columns | Only what P02 uses. `masked_text` comes in P05, more statuses in P08. | The P01 rule: each table and column comes with the phase that uses it. Decided during spec review. |
| Endpoints | `POST /interactions`, `GET /interactions/:id`, `GET /interactions` (paged), `GET /health` | Reading back and listing make the demo and tests easy; health is the container's healthcheck. Decided during spec review. |
| Loader input | `eval/data/dataset.jsonl` by default; `--file` for another JSONL file, such as the injection set. It sends only `external_id`, `channel`, `language` and `text`. | Labels stay out of the database. Decided during spec review. |
| Limits | `text` up to 20,000 characters (the longest dataset message has about 1,850); request body up to 256 KB; unknown fields rejected; list page size up to 100 | Keeps oversized or malformed input out of the database and, later, out of model calls. |
| Authentication | A static API key in the header `x-api-key`, read from `INTAKE_API_KEY` (at least 32 characters). Required on `/interactions*`; `/health` is open for the container healthcheck. Compared in constant time. The app refuses to start without the key. | Decided during spec review. The header name, length rule and open `/health` are Claude's proposal. |

### Plan

| Decision | Choice | Why |
| --- | --- | --- |
| Web framework | Fastify (current major, checked with ctx7 at implementation) | [tech-stack.md](../../tech-stack.md). |
| Request validation | Fastify's built-in JSON Schema validation (Ajv); schemas `as const`, with types from json-schema-to-ts | The same schema style as P00 and the P03 output schema. Ajv is configured with `removeAdditional: false`; Fastify's default would drop unknown fields silently instead of rejecting them. Decided during spec review. |
| Store interface | Routes depend on an `InteractionStore` interface. `KyselyInteractionStore` implements it for PostgreSQL; an in-memory store is used for unit tests. | Unit tests run without Docker ([tech-stack.md](../../tech-stack.md), Tests). |
| Idempotent insert | `insert … on conflict (external_id) do nothing returning *`. If no row comes back, the existing row is read and compared. | Safe when two requests with the same ID arrive at once; no read-then-write race. |
| App in Compose | Yes. Multi-stage `Dockerfile` on a pinned `node:24.x-alpine` image. `npm run build` compiles with TypeScript 7 to `dist/`, and the runtime stage has production dependencies only and runs `node dist/api/server.js`. | One command starts the stack ([tech-stack.md](../../tech-stack.md), Local setup). Decided during spec review. |
| Migrations in Compose | A one-shot `migrate` service runs the compiled migrator; `app` waits for it to finish (`depends_on: service_completed_successfully`). | A broken migration stops the stack with a clear error, and the app never races a migration. Decided during spec review. |
| Network binding | The app binds to `0.0.0.0` inside its container; Compose publishes it on `127.0.0.1:${APP_PORT:-3000}` only. `npm run dev` binds to `127.0.0.1`. | The API is reachable from this machine only. |
| Loader transport | Real HTTP (`fetch`) to `API_URL` (default `http://localhost:3000`), one request at a time, with the key from `INTAKE_API_KEY`. It prints the number created, already present and failed, and exits non-zero if any failed. | Matches the roadmap ("through the API"). Decided during spec review. |
| Logging | Fastify's logger (pino). It never logs request bodies, and the `x-api-key` header is redacted. | Message text is personal data until masking (P05) ([mission.md](../../mission.md), Privacy by design). |
| CI | The integration job sets a non-secret test key, runs `docker compose up -d --wait` (now building the image and starting `migrate` and `app`), checks `/health`, then runs `test:integration`. | CI checks the Dockerfile and the Compose wiring, not only the code. A test key is not a secret, so it lives in the workflow. |

### Validation

| Decision | Choice | Why |
| --- | --- | --- |
| API tests | Unit tests (`npm test`) cover validation, status codes, auth and 404 through `fastify.inject` with the in-memory store. Integration tests cover the same routes against PostgreSQL (dedupe, conflict, paging), the migration round trip with the new table, and the loader against a server on a random port. | Decided during spec review. |

## Notes

- **The P01 CI comment changes.** The integration job's `docker compose up -d --wait` now also builds the app image and runs migrations. The P01 reason (same Compose file as locally) still holds.
- **`INTAKE_API_KEY` must be added to your own `.env`** (generate one with `openssl rand -hex 32`). `.env.example` gets an empty entry with that instruction; Claude does not edit `.env`. Compose reads the key from `.env`. If it is empty, the `app` service exits with a clear message, while `postgres`, `redis` and `migrate` still start.
- **The migrator's folder in `dist/`.** `src/db/migrate.ts` finds migrations next to itself, so after compiling it finds `dist/db/migrations/*.js`. The integration test still runs the TypeScript sources. Plan 3.3 checks the compiled path.
- **TypeScript 7 emit.** `npm run build` uses the TypeScript 7 compiler (the `@typescript/native` alias). If its emit turns out to be unsuitable, falling back to the TypeScript 6 compiler for the build is raised as a decision first.
- **`interactions.language` is now nullable** in [tech-stack.md](../../tech-stack.md)'s data model, and `external_id` and `created_at` are added there.
- **Postgres and Redis ports are now published on `127.0.0.1` only** (they were on all interfaces since P01). This matches the app's binding and keeps the development credentials off the local network. Decided after spec review.
- **Implementation notes (recorded during implementation):**
  - Request bodies are validated with an Ajv instance that has type coercion off (Fastify's default would turn `"text": 123` into `"123"`). Query strings and path parameters keep coercion, because `?limit=10` arrives as text.
  - The migrator now needs only `DATABASE_URL` (`loadDatabaseUrl`), because the `migrate` container has no Redis.
  - Errors with status 500 get a generic message, so database error text never reaches the caller.
  - Dependabot ignores major updates of the `node` base image, for the same reason it ignores `@types/node` majors: the image follows the Node 24 runtime.
  - The CI integration job also sends one `POST /interactions` through the published port, with `curl`, as a smoke test, and prints the Compose logs if a step fails.
