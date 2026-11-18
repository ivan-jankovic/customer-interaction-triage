# Phase 1 — Project skeleton: Validation

The branch `p01-project-skeleton` can be merged when every check below passes.

**(test)** means automated in Vitest: unit tests under `test/` (`npm test`), integration tests under `test/integration/` (`npm run test:integration`). **(ci)** means a step in the GitHub Actions workflow that must be green on the pull request. **(manual)** means it needs a command or human judgement.

## Checks pass

- [x] `npm run lint` passes with typescript-eslint `recommendedTypeChecked`; every disabled rule or inline disable has a written reason. **(ci)**
- [x] `npm run format:check` passes. **(ci)**
- [x] `npm run typecheck` passes and runs TypeScript 7.0.x (`npx tsc --version` through the script's binary). **(ci)**
- [x] `npm test` passes without Docker running, with no network access and no `ANTHROPIC_API_KEY` set; the P00 tests keep their assertions (only formatting and lint fixes such as `Promise.resolve` instead of `async` without `await`). **(ci)**
- [x] `npm run audit` passes with an empty allowlist (picomatch 4.0.7 fixed GHSA-fc5q-39xc-vjpf), or any new entry was decided with the user and recorded in requirements.md. **(ci)**

## Local services

- [x] `docker compose up -d --wait` starts PostgreSQL and Redis, and both report healthy. **(manual)**
- [x] Both images are pinned to an exact minor version (no `latest`, no major-only tag). **(manual)**
- [x] Redis runs with `appendonly yes` and both services use named volumes. **(test)** for AOF, **(manual)** for volumes
- [x] `.env.example` has `DATABASE_URL` and `REDIS_URL` that work with the Compose defaults. **(manual)**

## Database and migrations

- [x] `npm run db:migrate` on an empty database applies the baseline migration and prints its result. **(manual)**
- [x] Migrations run to latest, roll back to none, and run to latest again on a fresh database, each step reporting success. **(test)**
- [x] Redis answers `PING` with `PONG`. **(test)**
- [x] `src/config.ts` fails with a clear message when `DATABASE_URL` or `REDIS_URL` is missing. **(test)**
- [x] `npm run test:integration` passes locally against Compose and in the CI `integration` job. **(ci)**

## GitHub and CI

- [x] The repository is private; no commit in its history contains `.env` or an `sk-ant-` key. **(manual)**
- [x] CI runs on the pull request with two jobs, `checks` and `integration`, and both are green. **(ci)**
- [x] The workflow sets `permissions: contents: read`, and every `uses:` points to a full 40-character commit SHA. **(manual)**
- [x] `.github/dependabot.yml` covers `npm`, `github-actions` and `docker-compose`, weekly. **(manual)**
- [x] `main` is protected (PR and both checks required), or requirements.md records that the plan doesn't allow it and CLAUDE.md states the convention. **(manual)**

## Docs and specs updated

- [x] The prettier formatting commit is listed in `.git-blame-ignore-revs`. **(manual)**
- [x] `README.md` lists the local setup commands, and following them on a clean checkout works. **(manual)**
- [x] [tech-stack.md](../../tech-stack.md) names Kysely, the TypeScript 6 API for linting, and the CI jobs. **(manual)**
- [x] `CLAUDE.md` describes the pull request merge flow and `test:integration`. **(manual)**
- [x] P01 is marked done in [roadmap.md](../../roadmap.md). **(manual)**

## Demo (roadmap)

- [x] `docker compose up` starts the database and Redis; `npm test` passes. **(manual)**

## Done when (roadmap)

- [x] CI is green on the P01 pull request. **(ci)**

## Scope checks

- [x] No Dockerfile, no app service in Compose, no Fastify dependency, no `src/api/` (P02). **(manual)**
- [x] No migration creates a table (P02 and later). **(manual)**
- [x] No BullMQ dependency or queue code (P08). **(manual)**
- [x] No model call in CI and no `ANTHROPIC_API_KEY` secret (P04). **(manual)**
