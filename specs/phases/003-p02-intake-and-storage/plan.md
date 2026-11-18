# Phase 2 — Intake and storage: Plan

See [requirements.md](requirements.md) for scope and decisions, and [validation.md](validation.md) for the merge checklist.

Nothing in this phase calls a model. After every group, `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` pass. `npm run test:integration` must also pass after groups that touch the database (with `docker compose up -d --wait`).

## 1. The `interactions` table

1.1. Write `src/db/migrations/0001_interactions.ts`. `up` creates the table from requirements.md (Data): `uuidv7()` default, check constraints for `channel`, `language` and `status`, a unique index on `external_id`, and an index on `received_at`. `down` drops the table.
1.2. Add the `InteractionsTable` type to the `Database` interface in `src/db/database.ts`, and remove the eslint-disable on the empty interface.
1.3. Extend `test/integration/migrations.int.test.ts` with these checks:
  - after `latest`, the table exists and its check constraints reject a bad `channel`;
  - after rolling back, the table is gone.

## 2. Store

2.1. Write `src/db/interactions.ts`:
  - the `InteractionStore` interface (`create`, `getById`, `list`);
  - the result type of `create`: `created`, `existing` or `conflict`;
  - `KyselyInteractionStore`, with the idempotent insert from requirements.md (Decisions, Plan).
2.2. Write `test/support/memory-interaction-store.ts`, an in-memory store with the same behaviour, for unit tests.

## 3. API

3.1. Check the current docs with ctx7: the Fastify major version and route schemas, `@fastify/type-provider-json-schema-to-ts`, and the Ajv options for rejecting unknown fields. Install `fastify` and the type provider.
3.2. Configuration in `src/config.ts`:
  - Add `loadApiConfig(env)`: `DATABASE_URL`, `INTAKE_API_KEY` (required, at least 32 characters), `HOST` (default `127.0.0.1`) and `PORT` (default `3000`).
  - Keep `loadServiceConfig` for the integration tests.
  - Add unit tests.
3.3. Write `src/api/schemas.ts` with the request, params, query and response schemas `as const`.
3.4. Write `src/api/app.ts`:
  - `buildApp({ store, apiKey, checkDb, logger })`;
  - the body limit of 256 KB;
  - the Ajv options;
  - the API-key hook on `/interactions*`, with a constant-time comparison;
  - the routes and the response mapping (`raw_text` → `text`).
3.5. Write `src/api/server.ts`. It loads the config, creates the database and the store, starts listening, closes the database on `SIGINT` and `SIGTERM`, and sets up pino with header redaction and no body logging.
3.6. Add scripts and env entries:
  - Scripts: `dev` (`tsx watch --env-file-if-exists=.env src/api/server.ts`), `build` (TypeScript 7 with `tsconfig.build.json`: `src/` only, emitting to `dist/`) and `start` (`node dist/api/server.js`).
  - Add `dist/` to `.gitignore`, `.prettierignore` and the ESLint ignores.
  - Add `INTAKE_API_KEY`, `PORT` and `API_URL` to `.env.example`.
3.7. Check that the compiled migrator finds `dist/db/migrations/*.js`. Add a `db:migrate:dist` script (`node dist/db/migrate.js latest`) for the container.
3.8. Write unit tests in `test/api/interactions.test.ts`, using `fastify.inject` and the in-memory store. One test or more per row of the responses table in requirements.md, plus:
  - unknown fields;
  - text limits;
  - whitespace-only text;
  - list paging and `limit` bounds;
  - `/health` without a key;
  - the 401 response.
3.9. Write `test/integration/api.int.test.ts`: the same app with `KyselyInteractionStore` on a throwaway database, covering create, the 200 repeat, the 409 conflict, get by ID and paging over 25 rows.

## 4. Loader

4.1. Write `eval/dataset/load.ts` with an exported `loadFile({ file, apiUrl, apiKey, fetch })`.
  - It reads JSONL with the existing `eval/lib/jsonl.ts`.
  - It sends only `external_id`, `channel`, `language` and `text`.
  - It reports counts (created, existing, failed).
  - The CLI wrapper takes `--file` and reads `API_URL` and `INTAKE_API_KEY`.
  - It prints a clear message if the API is not reachable.
  - Script: `dataset:load` (`tsx --env-file-if-exists=.env eval/dataset/load.ts`).
4.2. Unit test with a fake `fetch`: only the four fields are sent, labels never; 201/200/error responses are counted; the exit code is non-zero on failures.
4.3. Integration test: the real app listens on port 0 with the PostgreSQL store, and the loader runs twice over a three-record temporary file. The first run reports 3 created, the second 3 existing, and the table has 3 rows.

## 5. Docker and Compose

5.1. Look up the current Node 24 Alpine image and pin its exact version. Write the `Dockerfile` and `.dockerignore` (exclude `.env*` except `.env.example`, `node_modules`, `.git`, `dist`, `eval`, `test`).
  - The build stage runs `npm ci` and `npm run build`.
  - The runtime stage runs `npm ci --omit=dev`, copies `dist/`, and runs as the non-root `node` user.
5.2. Add two services to `docker-compose.yml`:
  - `migrate`: the same image with command `node dist/db/migrate.js latest`, depending on a healthy `postgres`.
  - `app`: depends on `migrate` completing successfully. Environment: `DATABASE_URL` pointing at the `postgres` service, `INTAKE_API_KEY: ${INTAKE_API_KEY:-}` and `HOST=0.0.0.0`. Port `127.0.0.1:${APP_PORT:-3000}:3000`. Healthcheck with `node -e "fetch('http://127.0.0.1:3000/health')…"`.
  - Publish the `postgres` and `redis` ports on `127.0.0.1` only (`127.0.0.1:${POSTGRES_PORT:-5432}:5432`, same for Redis).
  - Update the header comment.
5.3. Run `docker compose up -d --wait`. All four services reach their final state (healthy, or `migrate` exited 0), and `curl` with the key creates and reads an interaction.
5.4. Add the `docker` ecosystem (directory `/`, weekly) to `.github/dependabot.yml`.

## 6. CI

6.1. Update the integration job in `.github/workflows/ci.yml`:
  - Set `INTAKE_API_KEY` to a fixed, non-secret test value, with a comment saying why it is not a secret.
  - `docker compose up -d --wait` (builds the image).
  - A `curl --fail` on `/health`.
  - `npm run test:integration`.
  - `docker compose down -v` (always).
  - Update the comment.
6.2. Add a `npm run build` step to the `checks` job, so a compile error in emit settings fails fast.

## 7. Verify and document

7.1. Run lint, format check, type check, unit tests, `npm run build`, `npm run audit`, and the integration tests against Compose.
7.2. Demo: run `docker compose up -d --wait` and then `npm run dataset:load`; it reports 100 created. Run it again; it reports 100 existing. Check in `psql` that there are 100 rows, with counts by channel and language that match `eval/data/README.md`.
7.3. Update the docs:
  - `README.md`: running the stack, the API key, a curl example and the loader.
  - [tech-stack.md](../../tech-stack.md): the `interactions` columns, with `language` nullable and `masked_text` from P05.
  - CLAUDE.md, only if a working rule changes.
7.4. Work through [validation.md](validation.md). Mark P02 done in [roadmap.md](../../roadmap.md) after review, then push, open the PR and ask before merging.
