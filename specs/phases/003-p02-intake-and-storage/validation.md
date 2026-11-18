# Phase 2 — Intake and storage: Validation

The branch `p02-intake-and-storage` can be merged when every check below passes.

How each check is marked:

- **(test):** automated in Vitest.
  - Unit tests are under `test/` and run with `npm test`.
  - Integration tests are under `test/integration/` and run with `npm run test:integration`.
- **(ci):** a step in the GitHub Actions workflow that must be green on the pull request.
- **(manual):** needs a command or human judgement.

## Checks pass

- [x] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build` and `npm run audit` pass. **(ci)**
- [x] `npm test` passes without Docker running, with no network access and with no `ANTHROPIC_API_KEY` or `INTAKE_API_KEY` set. **(ci)**
- [x] `npm run test:integration` passes locally against Compose and in the CI `integration` job. **(ci)**
- [x] No new dependency brings an audit advisory, or any new allowlist entry was decided with the user and recorded in requirements.md. **(ci)**

## Storage

- [x] The migration creates `interactions` with the columns and constraints in requirements.md (Data). Rolling back drops it, and migrating again recreates it. **(test)**
- [x] The database rejects a `channel`, `language` or `status` outside the allowed values. **(test)**
- [x] New rows get a `uuidv7()` ID, `status = 'received'` and a `created_at`. **(test)**

## API

- [x] `POST /interactions` with a valid body returns 201, a `Location` header and the stored interaction; `raw_text` matches the request byte for byte. **(test)**
- [x] `received_at` defaults to the intake time and keeps the time given in the request. **(test)**
- [x] A repeat with the same `external_id` and the same content returns 200 and the same `id`, and no new row. **(test)** for unit and integration
- [x] A repeat with the same `external_id` and different content returns 409, and nothing changes. **(test)** for unit and integration
- [x] Each of these returns 400 and names the failing field: missing `channel` or `text`, an unknown `channel` or `language`, whitespace-only text, text over 20,000 characters, an unknown field, a `received_at` without a time zone, a malformed ID. **(test)**
- [x] A body over 256 KB is rejected with 413. **(test)**
- [x] `/interactions*` without `x-api-key`, or with a wrong one, returns 401, and the body does not say which. **(test)**
- [x] `/health` answers without a key: 200 when the database is reachable, 503 when it is not. **(test)**
- [x] `GET /interactions/:id` returns the interaction, or 404 for an unknown ID. **(test)**
- [x] `GET /interactions` pages newest first. Over 25 rows with `limit=10`, it gives pages of 10, 10 and 5; `next_before` is `null` on the last page; a `limit` of 0 or 101 returns 400. **(test)** for unit and integration
- [x] The app does not start without `INTAKE_API_KEY`, or with a key under 32 characters, and says why. **(test)**
- [x] Request logs contain neither message text nor the API key. **(test)** (log stream captured in a unit test)

## Loader

- [x] The loader sends only `external_id`, `channel`, `language` and `text`; no labels reach the API. **(test)**
- [x] Running the loader twice over the same file reports all created, then all existing, and the table holds each record once. **(test)** (integration, 3 records)
- [x] The loader exits non-zero and prints a clear message when the API is unreachable or a record fails. **(test)**
- [x] Demo: with the stack up, `npm run dataset:load` reports 100 created; a second run reports 100 existing. `psql` shows 100 rows, with counts per channel and language matching `eval/data/README.md`. **(manual)**
- [x] `npm run dataset:load -- --file eval/data/injection.jsonl` loads the 15 injection messages. **(manual)**

## Docker and CI

- [x] `docker compose up -d --wait` builds the image, `migrate` exits 0, and `app`, `postgres` and `redis` report healthy. **(manual)** and **(ci)**
- [x] The Node base image is pinned to an exact version; the runtime image has no dev dependencies, no `.env`, and runs as a non-root user. **(manual)**
- [x] The app, PostgreSQL and Redis ports are published on `127.0.0.1` only (`docker compose ps` shows `127.0.0.1:` for each). **(manual)**
- [x] With `INTAKE_API_KEY` empty, `app` exits with a clear message, while `postgres`, `redis` and `migrate` still start. **(manual)**
- [x] Dependabot watches the `Dockerfile` (`docker` ecosystem). **(manual)**
- [x] The CI test key is a fixed, non-secret value, with a comment saying why it is not a secret; no real secret is added to the repository. **(manual)**

## Specs updated

- [x] [tech-stack.md](../../tech-stack.md) lists the final `interactions` columns. **(manual)**
- [x] `README.md` explains how to start the stack, set the API key, call the API and load the dataset. **(manual)**
- [x] P02 is marked done in [roadmap.md](../../roadmap.md) after review. **(manual)**

## Scope checks

- [x] Nothing is written to Redis, and no queue code exists (P08). **(manual)**
- [x] There is no `masked_text` column and no classification or case table. **(manual)**
- [x] No model is called, and nothing reads `ANTHROPIC_API_KEY`. **(manual)**
