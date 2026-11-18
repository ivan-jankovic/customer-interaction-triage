# Phase 1 — Project skeleton: Plan

See [requirements.md](requirements.md) for scope and decisions, and [validation.md](validation.md) for the merge checklist.

Nothing in this phase calls a model. After every group, `npm run typecheck` and `npm test` pass (and `npm run lint` from group 2 on).

## 1. TypeScript side by side

1.1. Check the current docs (ctx7) for the TypeScript 6/7 side-by-side setup and typescript-eslint's requirements.
1.2. In `package.json`: `typescript` → `npm:@typescript/typescript6@6.0.x` (used by ESLint), and TypeScript 7.0.2 under an alias (for example `@typescript/native`) whose `tsc` binary `npm run typecheck` calls. Add a comment entry explaining why and when to remove it, and record it in requirements.md if the details differ.
1.3. Verify `npm run typecheck` still runs TypeScript 7.0.2 (`tsc --version` through the script) and `npm test` passes.

## 2. ESLint

2.1. Install `eslint`, `@eslint/js` and `typescript-eslint`; write `eslint.config.js` (flat config) with `recommendedTypeChecked` and `parserOptions.projectService`, covering `src`, `eval`, `test` and the config files.
2.2. Add the `lint` script (`eslint .`), run it and fix the P00 code. Each disabled rule or inline disable gets a one-line reason.
2.3. Run `npm run audit`; if a new advisory appears, stop and raise it.

## 3. Prettier

3.1. Install `prettier` and `eslint-config-prettier` (turns off ESLint style rules that clash). Write `.prettierrc.json` (`printWidth: 120`) and `.prettierignore` (`*.md`, `eval/data/`, `package-lock.json`, `node_modules/`).
3.2. Add the `format` and `format:check` scripts.
3.3. Run `npm run format` and commit the result alone ("Format with Prettier"), with no other changes.
3.4. Add that commit's hash to `.git-blame-ignore-revs` in a second commit, with a note in README on `git config blame.ignoreRevsFile`.

## 4. Docker Compose

4.1. Look up the current stable PostgreSQL and Redis releases and pin exact minor image tags.
4.2. Write `docker-compose.yml`: `postgres` (database, user and password for local development only, healthcheck `pg_isready`, named volume) and `redis` (`redis-server --appendonly yes`, healthcheck `redis-cli ping`, named volume). Host ports from `POSTGRES_PORT` / `REDIS_PORT` with defaults 5432 / 6379.
4.3. Add `DATABASE_URL` and `REDIS_URL` to `.env.example`, matching the Compose defaults.
4.4. Check `docker compose up -d --wait` reports both services healthy.

## 5. Database and migrations

5.1. Install `kysely`, `pg`, `@types/pg` and `ioredis`; check the Kysely migrator docs (ctx7).
5.2. Write `src/config.ts`: reads `DATABASE_URL` and `REDIS_URL` and fails with a clear message when one is missing.
5.3. Write `src/db/database.ts` (`createDb(url)`, returns a `Kysely` instance with an empty `Database` interface for now) and `src/redis.ts` (`createRedis(url)`).
5.4. Write `src/db/migrate.ts`: a Kysely `Migrator` over `src/db/migrations/`, with `latest` and `down` commands that print each migration's result and exit non-zero on error. Scripts `db:migrate` and `db:rollback` (through tsx, `--env-file-if-exists=.env`).
5.5. Write the baseline migration `src/db/migrations/0000_baseline.ts` (no schema changes, with a comment saying why).
5.6. Unit tests for `src/config.ts` (missing and present variables).

## 6. Integration tests

6.1. Add `vitest.integration.config.ts` (includes `test/integration/**/*.int.test.ts`, the same no-model-calls setup file) and the `test:integration` script; make sure `vitest.config.ts` does not pick up these files.
6.2. `test/integration/migrations.int.test.ts`: on a fresh database, migrate to latest (baseline recorded in Kysely's migration table), roll back (table empty), migrate again; every result is `Success`.
6.3. `test/integration/redis.int.test.ts`: `PING` returns `PONG`; `CONFIG GET appendonly` returns `yes`.
6.4. Run both locally against Compose.

## 7. GitHub repository and CI

7.1. Check the history before the first push: no `.env` in any commit (`git log --all -- .env`), and no API key pattern (`sk-ant-`) in any commit.
7.2. Create the private repository with `gh repo create`, add it as `origin`, push `main` and `p01-project-skeleton`.
7.3. Write `.github/workflows/ci.yml`: on `pull_request` and on `push` to `main`; `permissions: contents: read`; concurrency cancels older runs of the same ref; Node from `.nvmrc` with npm cache.
   - Job `checks`: `npm ci`, `lint`, `format:check`, `typecheck`, `test`, `audit`.
   - Job `integration`: `npm ci`, `docker compose up -d --wait`, `test:integration` (which migrates the database itself), `docker compose down -v` at the end.
   - Every action pinned to a full commit SHA with the version in a comment.
7.4. Write `.github/dependabot.yml`: weekly updates for `npm`, `github-actions` and `docker-compose`.
7.5. Open the pull request for P01 and get CI green.
7.6. Protect `main` with `gh api` (pull request required, the `checks` and `integration` checks required, enforced for admins). If GitHub refuses because of the plan, note it in requirements.md and rely on the convention.

## 8. Docs and specs

8.1. Write a short root `README.md`: what the project is (one paragraph, linking `specs/mission.md`), requirements (Node 24, Docker), and the local commands: `npm ci`, `docker compose up -d --wait`, `npm run db:migrate`, `npm test`, `npm run test:integration`, `npm run lint`.
8.2. Update [tech-stack.md](../../tech-stack.md): Kysely and its migrator in the Core table (Database row), the TypeScript 6 API used for linting, the CI jobs and Dependabot.
8.3. Update `CLAUDE.md`: phases are merged through a pull request after CI is green (Claude still asks before merging); `npm run test:integration` needs the Compose services; `npm run lint` is now real.

## 9. Verify

9.1. Run `lint`, `format:check`, `typecheck`, `test`, `audit` and `test:integration` locally.
9.2. Work through [validation.md](validation.md).
9.3. After review, mark P01 done in [roadmap.md](../../roadmap.md) on this branch, push, and ask before merging the pull request.
