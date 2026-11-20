# Phase 1 — Project skeleton: Requirements

## Context

This is phase P01 in [roadmap.md](../../roadmap.md). P00 left a working TypeScript project behind: `src/taxonomy.ts` and `src/company.ts`, the dataset scripts and data under `eval/`, Vitest tests under `test/`, and the `typecheck`, `test` and `audit` scripts. There is no linter, no formatter, no database, no queue, no GitHub repository and no CI yet.

P01 builds the base every later phase stands on: code style that is checked, PostgreSQL and Redis running locally with one command, a migration setup, and CI that runs on every pull request. The mission's success criterion "Unit tests run in CI without calling a model" ([mission.md](../../mission.md)) starts here.

## Scope

In scope:

- **ESLint** (flat config, typescript-eslint `recommendedTypeChecked`) over `src`, `eval`, `test` and the config files, and the `lint` script. P00 code is fixed to pass.
- **Prettier** with a `format` and a `format:check` script. The existing code is formatted in one commit that is listed in `.git-blame-ignore-revs`.
- **Docker Compose** (`docker-compose.yml`) with PostgreSQL and Redis: pinned image versions, healthchecks, named volumes, and Redis with append-only persistence (AOF).
- **Database access and migrations** with Kysely: a `src/db/` module that creates the connection from `DATABASE_URL`, a migration runner, a baseline migration, and the `db:migrate` and `db:rollback` scripts.
- **Redis connection** helper from `REDIS_URL` (ioredis, the client BullMQ uses in P08).
- **Integration tests** in a separate `test:integration` script: migrations run up, down and up again on an empty database; Redis answers `PING` and has AOF on.
- **GitHub:** a private repository created with `gh`, `main` and this branch pushed, branch protection on `main` if the plan allows it.
- **CI** (GitHub Actions): lint, format check, type check, unit tests and `npm run audit` in one job; the integration tests against the Compose services in a second job. Actions pinned to commit SHAs.
- **Dependabot** for npm, GitHub Actions and the Compose images, weekly.
- **Configuration:** `DATABASE_URL` and `REDIS_URL` in `.env.example`, matching the Compose defaults.
- **A short root `README.md`** with the local setup commands (install, `docker compose up`, migrate, test). The full README with the design comes with later phases.
- **Updates to the constitution and working rules:** tech-stack.md (Kysely, the TypeScript 6 API for linting, CI shape) and CLAUDE.md (merge through a pull request with green CI, `test:integration`). Approving this spec approves these edits.

Out of scope (later phases):

- The app container, Dockerfile and Fastify (P02, with the intake API).
- Any table of the data model, including `interactions` (P02 and later; each table comes with the phase that uses it).
- BullMQ queues and workers (P08). P01 only checks that Redis is reachable.
- The evaluation subset in CI and the `ANTHROPIC_API_KEY` CI secret (P04).
- Code coverage thresholds and release or deployment workflows (not planned).

## Decisions

### Repository and workflow

| Decision | Choice | Why |
| --- | --- | --- |
| GitHub repository | Private, created by Claude with `gh repo create`; `main` and the phase branch are pushed | Can be made public later. Before the first push, the history is checked for `.env` and API keys. Decided during spec review. |
| Merge flow | From now on every phase is merged through a pull request (merge commit) after CI is green. Claude still asks before merging. | Matches the roadmap's "Done when: CI is green", and keeps one merge commit per phase as in P00. Decided during spec review. |
| Branch protection | Protect `main`: pull request required, the CI checks required, applied to admins too. If the account's plan does not allow protection on a private repo (GitHub Free), the rule is a convention in CLAUDE.md only. | Decided during spec review. |
| P01's own merge | P01 is the first phase merged through a PR. Protection is set up after the first CI run, because GitHub can only require a check it has seen. | Bootstrapping order. |

### Local services and database

| Decision | Choice | Why |
| --- | --- | --- |
| Compose services | PostgreSQL and Redis only; the app service comes in P02 | Nothing to run yet. Decided during spec review. |
| Images | Exact minor versions of the current stable PostgreSQL and Redis releases (checked at implementation), in Compose; Dependabot keeps them current | Reproducible local setup and CI. Decided during spec review. |
| Redis persistence | `appendonly yes` and a named volume | Required by tech-stack.md ("Queue consistency"). |
| Host ports | `5432` and `6379` by default, overridable with `POSTGRES_PORT` and `REDIS_PORT` | Lets a developer with a local PostgreSQL or Redis avoid a clash without editing the Compose file. |
| Database library | Kysely (query builder on `pg`) with its built-in migrator; migrations in TypeScript under `src/db/migrations/` | Typed SQL without an ORM or a code generation step. Decided during spec review. |
| First migration | A baseline migration with no schema changes; it marks the start of the history. Tables come with the phases that use them. | Columns are decided in the spec of the phase that owns each table. Decided during spec review. |
| Redis client | ioredis | BullMQ (P08) is built on it, so there is one Redis client in the project. |

### Tooling

| Decision | Choice | Why |
| --- | --- | --- |
| ESLint rules | typescript-eslint `recommendedTypeChecked` | Catches floating promises and unsafe `any`, which matter in a queue-based app. Decided during spec review. |
| TypeScript 7 and typed linting | typescript-eslint does not run with TypeScript 7.0 (its peer range is `>=4.8.4 <6.1.0`; TS 7 support is experimental and needs 7.1). The package `typescript` resolves to `@typescript/typescript6` (6.0.x) for ESLint, and TypeScript 7.0.2 is installed under an alias for `npm run typecheck`. The alias is removed once typescript-eslint supports TS 7.1+. | The side-by-side setup documented by Microsoft and typescript-eslint. Decided during spec review. |
| Prettier | Print width 120, otherwise defaults; one formatting commit listed in `.git-blame-ignore-revs`. Markdown files and `eval/data/` are excluded. | 120 matches the current code, so the reformat stays small. Markdown is excluded because Prettier would realign every spec table; JSONL has no Prettier parser. Decided during spec review (width and exclusions are Claude's proposal). |
| Unit vs. integration tests | `npm test` stays unit-only and runs without Docker. `npm run test:integration` (own Vitest config, files `test/integration/**/*.int.test.ts`) needs the Compose services. | Unit tests keep running anywhere. Decided during spec review. |
| Services in CI | The integration job starts the services with `docker compose up -d --wait`, not with GitHub service containers, so CI runs Redis with AOF exactly as locally | GitHub service containers cannot pass a start command, so Redis would run there without AOF and the AOF test would have to be skipped in CI. With Compose, CI tests the real configuration (image tags, AOF, healthchecks) from one file. This changes the "service containers" wording of the spec-review option; the intent (a separate job with real PostgreSQL and Redis) is the same. |

### Supply chain

| Decision | Choice | Why |
| --- | --- | --- |
| Dependency audit | `npm run audit` (audit-ci, threshold `low`, the P00 allowlist) runs in CI | A new advisory fails the build. Decided during spec review. |
| GitHub Actions | Every action referenced by full commit SHA, with the version in a comment; workflow `permissions: contents: read` | A moved tag cannot change what runs. Decided during spec review. |
| Dependabot | Weekly, for `npm`, `github-actions` and `docker-compose` | Pinned versions don't go stale. Decided during spec review. |

## Notes

- **P00 code will change.** The formatting commit touches most `.ts` files, and some P00 code needs small fixes for ESLint (for example unhandled promises in the CLI scripts). Behaviour does not change; the P00 tests must still pass unchanged.
- **Branch protection is not available (outcome of plan 7.6).** GitHub answered "Upgrade to GitHub Pro or make this repository public" (HTTP 403), so the PR-with-green-CI rule is a convention in CLAUDE.md. (Update, 2026-11-20, after P14: the repository was made public and the protection was added as a ruleset on `main`, as decided here.) The repository settings allow only merge commits (no squash or rebase merges) and delete a branch after its PR is merged.
- **The P00 audit allowlist is gone.** Reinstalling in group 1 pulled picomatch 4.0.7, which fixes GHSA-fc5q-39xc-vjpf; `npm audit` reports nothing, so the allowlist in `audit-ci.jsonc` is now empty.
- **New dependencies may bring new advisories.** If ESLint or Kysely pull in an advisory, it is raised for a decision, not silently allowlisted.
- **tech-stack.md is out of date in one place:** it says structured output goes "through tool use", but P00 found that forced tool use is rejected on the current models and used `output_config.format` instead. This is P03's concern; P01 does not change it, but P03's spec should.
- **CLAUDE.md's "Ask before merging" stays.** The PR flow adds CI as a gate; it does not replace the question.
