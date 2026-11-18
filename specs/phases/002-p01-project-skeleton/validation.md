# Phase 1 — Project skeleton: Validation

The branch `p01-project-skeleton` can be merged when every check below passes.

**(test)** means automated in Vitest: unit tests under `test/` (`npm test`), integration tests under `test/integration/` (`npm run test:integration`). **(ci)** means a step in the GitHub Actions workflow that must be green on the pull request. **(manual)** means it needs a command or human judgement.

## Checks pass

- [ ] `npm run lint` passes with typescript-eslint `recommendedTypeChecked`; every disabled rule or inline disable has a written reason. **(ci)**
- [ ] `npm run format:check` passes. **(ci)**
- [ ] `npm run typecheck` passes and runs TypeScript 7.0.x (`npx tsc --version` through the script's binary). **(ci)**
- [ ] `npm test` passes without Docker running, with no network access and no `ANTHROPIC_API_KEY` set; the P00 tests pass unchanged apart from formatting. **(ci)**
- [ ] `npm run audit` passes; the allowlist is still only GHSA-fc5q-39xc-vjpf on its Vitest paths (or any new entry was decided with the user and recorded in requirements.md). **(ci)**

## Local services

- [ ] `docker compose up -d --wait` starts PostgreSQL and Redis, and both report healthy. **(manual)**
- [ ] Both images are pinned to an exact minor version (no `latest`, no major-only tag). **(manual)**
- [ ] Redis runs with `appendonly yes` and both services use named volumes. **(test)** for AOF, **(manual)** for volumes
- [ ] `.env.example` has `DATABASE_URL` and `REDIS_URL` that work with the Compose defaults. **(manual)**

## Database and migrations

- [ ] `npm run db:migrate` on an empty database applies the baseline migration and prints its result. **(manual)**
- [ ] Migrations run to latest, roll back to none, and run to latest again on a fresh database, each step reporting success. **(test)**
- [ ] Redis answers `PING` with `PONG`. **(test)**
- [ ] `src/config.ts` fails with a clear message when `DATABASE_URL` or `REDIS_URL` is missing. **(test)**
- [ ] `npm run test:integration` passes locally against Compose and in the CI `integration` job. **(ci)**

## GitHub and CI

- [ ] The repository is private; no commit in its history contains `.env` or an `sk-ant-` key. **(manual)**
- [ ] CI runs on the pull request with two jobs, `checks` and `integration`, and both are green. **(ci)**
- [ ] The workflow sets `permissions: contents: read`, and every `uses:` points to a full 40-character commit SHA. **(manual)**
- [ ] `.github/dependabot.yml` covers `npm`, `github-actions` and `docker-compose`, weekly. **(manual)**
- [ ] `main` is protected (PR and both checks required), or requirements.md records that the plan doesn't allow it and CLAUDE.md states the convention. **(manual)**

## Docs and specs updated

- [ ] The prettier formatting commit is listed in `.git-blame-ignore-revs`. **(manual)**
- [ ] `README.md` lists the local setup commands, and following them on a clean checkout works. **(manual)**
- [ ] [tech-stack.md](../../tech-stack.md) names Kysely, the TypeScript 6 API for linting, and the CI jobs. **(manual)**
- [ ] `CLAUDE.md` describes the pull request merge flow and `test:integration`. **(manual)**
- [ ] P01 is marked done in [roadmap.md](../../roadmap.md). **(manual)**

## Demo (roadmap)

- [ ] `docker compose up` starts the database and Redis; `npm test` passes. **(manual)**

## Done when (roadmap)

- [ ] CI is green on the P01 pull request. **(ci)**

## Scope checks

- [ ] No Dockerfile, no app service in Compose, no Fastify dependency, no `src/api/` (P02). **(manual)**
- [ ] No migration creates a table (P02 and later). **(manual)**
- [ ] No BullMQ dependency or queue code (P08). **(manual)**
- [ ] No model call in CI and no `ANTHROPIC_API_KEY` secret (P04). **(manual)**
