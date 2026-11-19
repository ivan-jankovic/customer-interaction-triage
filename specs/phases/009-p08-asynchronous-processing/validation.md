# Phase 8 — Asynchronous processing: Validation

The branch `p08-asynchronous-processing` can be merged when every check below passes.

How each check is marked:

- **(test):** automated in Vitest.
  - Unit tests run with `npm test`.
  - Integration tests are under `test/integration/` and run with `npm run test:integration` (real PostgreSQL and Redis, mocked LLM).
- **(ci):** a step in the GitHub Actions workflow that must be green on the pull request.
- **(manual):** needs a command or human judgement.

## Checks pass

- [ ] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build` and `npm run audit` pass, with `bullmq` installed. **(ci)**
- [ ] `npm test` passes with no `ANTHROPIC_API_KEY` and no network; no test calls a model. **(ci)**
- [ ] `npm run test:integration` passes locally and in CI, including the Redis outage tests. **(ci)**
- [ ] `docker compose up -d --wait` without a profile starts no worker (CI's stack is unchanged). **(manual)**

## Storage

- [ ] Migration `0007` allows the status `processed`, sets it on interactions that already have a case, and makes `cases.classification_id` nullable only for `processing_failed`; rolling back restores the old checks. **(test)**
- [ ] Writing a case (by routing or by the failure path) sets `interactions.status = 'processed'` in the same transaction. **(test)**

## Pipeline runner

- [ ] A fresh interaction runs mask → classify → enrich → route and ends with one case. **(test)**
- [ ] A second run reuses every step: no model call and no new rows. **(test)**
- [ ] An interaction with a valid classification resumes without a model call. **(test)**
- [ ] A transient error (connection, timeout, `408`, `409`, `429`, `≥ 500`) on a non-final attempt stores the attempt and retries; on the final attempt it ends as a `classification_error` case. **(test)**
- [ ] Other `4xx` errors, refusals, `max_tokens` and invalid output are never retried and end in review. **(test)**
- [ ] A non-model failure that persists to the last attempt ends as a `processing_failed` case in `general`, with the IDs of the steps that finished, a decision log of those steps, and no error message text. **(test)**
- [ ] `processing_failed` is never produced by `route()`; `route.v2` gives the same result as `route.v1` for every other input (the dataset-wide routing test still passes). **(test)**

## Queue and sweep

- [ ] Intake adds one job per stored interaction, with `jobId` = the interaction ID and the ID as the only data. **(test)**
- [ ] Intake answers `201` when enqueueing fails, and logs the ID only. **(test)**
- [ ] The sweep enqueues interactions with no case older than the grace period, skips fresh ones and ones with a case, and re-adds an interaction whose `failed` job left no case. **(test)**
- [ ] Stored-but-not-enqueued (the crash between storing and enqueueing) is processed by the sweep and ends with one case. **(test)**
- [ ] N interactions with duplicate enqueues and extra sweeps end as exactly N cases, with one model call each. **(test)**
- [ ] A stalled job (worker stopped mid-job) is picked up by another worker and ends with one case. **(test)**

## Redis outage

- [ ] With Redis stopped, intake still answers `201` within about 1 second; after Redis starts, the sweep processes the message. **(test)**
- [ ] A waiting job survives `docker compose stop redis` / `start redis` (append-only file and volume). **(test)**
- [ ] A running worker resumes processing after Redis comes back, without a restart. **(test)**

## Worker, commands and Compose

- [ ] The worker refuses to start without `ANTHROPIC_API_KEY`, `DATABASE_URL` or `REDIS_URL`, with a message naming what is missing. **(test)**
- [ ] Worker logs contain no message text, summary or identifier value. **(test)**
- [ ] `npm run process -- <id | external_id>` processes one interaction synchronously, prints each step as reused/ran/skipped and the case; a re-run makes no model call. **(test)**
- [ ] `npm run queue:status` prints job counts by state, interactions by status and the sweep backlog. **(test)**
- [ ] `docker compose --profile worker up -d` starts the worker with the variables from `.env`. **(manual)**

## Demo

- [ ] On a fresh separate database and Redis database 1, after `crm:seed` and the user's go-ahead (about $0.80), loading the dataset with the worker running ends with 100 interactions, 100 cases and an empty backlog. The review count, reason codes and cost are in the PR description. **(manual)**
- [ ] A message posted while the worker is stopped is processed once it starts. **(manual)**
- [ ] A message posted while Redis is stopped gets `201` and is processed after Redis starts. **(manual)**

## Evaluation

- [ ] Both kept runs are recomputed with `npm run eval:report`; the diffs change only the router version, and `outputs.jsonl` and `run.json` are unchanged. **(manual)**
- [ ] The golden report fixture's diff changes only the router version. **(manual)**

## Specs updated

- [ ] [tech-stack.md](../../tech-stack.md) records the queue consistency approach, the worker and its Compose profile, the data model changes and `route.v2`. **(manual)**
- [ ] `README.md` explains starting the worker (with the cost warning), `npm run process`, `npm run queue:status` and the async flow. **(manual)**
- [ ] P08 is marked done in [roadmap.md](../../roadmap.md) after review. **(manual)**

## Scope checks

- [ ] No review listing or corrections (P09); no investigation step (P10); no queue dashboard. **(manual)**
- [ ] Redis holds no message text: job data is the interaction ID only. **(test)**
- [ ] The prompts and `summary-judge.v1` are unchanged (registry hashes unchanged). **(test)**
- [ ] No model call outside the 100 demo classifications. **(manual)**
