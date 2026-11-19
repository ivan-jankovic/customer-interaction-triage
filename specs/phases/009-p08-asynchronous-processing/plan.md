# Phase 8 — Asynchronous processing: Plan

See [requirements.md](requirements.md) for scope and decisions, and [validation.md](validation.md) for the merge checklist.

**The only model calls are the 100 demo classifications in group 8, and only after asking.** After every group, `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` pass. `npm run test:integration` must also pass after groups that touch the database or Redis.

## 1. Dependencies, reason code and migration

1.1. Install `bullmq` (exact current v6 release; check its ioredis peer version matches ours). Run `npm run audit`.

1.2. Add `processing_failed` to the front of `REASON_CODES` in `src/taxonomy.ts`, with a comment that only the runner's failure path writes it. Set `ROUTER_VERSION = "route.v2"` in `src/pipeline/route.ts`; the rules don't change. Update the P07 tests that pin the code order or the version.

1.3. Migration `src/db/migrations/0007_processing.ts`, following requirements.md (Migration `0007`):
  - `interactions.status` check with `processed`, and existing interactions with a case set to `processed`;
  - `cases.classification_id` nullable, with the `processing_failed` check.

  Update the types in `src/db/database.ts` (`InteractionStatus`, nullable `classification_id`).

1.4. `routeInteraction` (`src/db/cases.ts`) also sets `interactions.status = 'processed'` inside its transaction, only when it inserted the case. `readCase` handles a null `classification_id`.

1.5. Integration tests (`test/integration/migrations.int.test.ts`, `cases.int.test.ts`): the migration round trip; the status is set by routing; the database rejects a null `classification_id` without `processing_failed`.

## 2. Transient errors in the LLM client

2.1. Add `status: number | null` to the `api_error` failure in `src/llm/client.ts` (`null` for connection errors and timeouts).

2.2. Add `isTransient(failure)` in `src/pipeline/process.ts` (or next to the client): connection errors and timeouts, `408`, `409`, `429`, `≥ 500`. Everything else is not transient.

2.3. Unit tests: the client maps each `Anthropic.APIError` subclass (including `APIConnectionError`) to its status; `isTransient` for each listed status and for `400`, `401`, `404`, refusal and `max_tokens`.

## 3. Pipeline runner

3.1. Write `src/pipeline/process.ts` with `PIPELINE_VERSION = "process.v1"` and `processInteraction(db, deps, interactionId, { finalAttempt })`, following requirements.md (Pipeline runner):
  - return the existing case at once if there is one;
  - mask (reuse), classify (reuse the latest valid one; otherwise call and store), enrich (reuse the latest from that classification), route;
  - a transient classify error on a non-final attempt: store the attempt, then throw `TransientModelError` so the job retries;
  - the result: `{ case, steps: { mask, classify, enrich, route }: "reused" | "ran" | "skipped" }`, used by the CLI and the tests.

  Add small helpers where the stores lack them: the latest valid classification, and the latest enrichment for a classification (`src/db/classifications.ts`, `src/db/enrichments.ts`).

3.2. Write `recordFailureCase(db, interactionId, { failedStep, error })` in `src/db/cases.ts`: the failure case and its decision-log entries in one transaction (requirements.md, Other failures), with `ON CONFLICT (interaction_id) DO NOTHING` like P07. The detail stores the step and the error's class name only.

  It also sets `interactions.status = 'processed'` in the same transaction.

3.3. Keep the retry decision in a pure function, `afterClassify(attempt, { finalAttempt })` → `"continue" | "retry"`, and unit-test it (`test/pipeline/process.test.ts`):
  - a transient error on a non-final attempt gives `retry`; on the final attempt, `continue` (route then gives `classification_error`);
  - non-transient errors, refusals, `max_tokens` and invalid output always give `continue`;
  - a valid classification gives `continue`.

3.4. Integration tests (`test/integration/process.int.test.ts`, mocked LLM):
  - a fresh interaction runs all four steps and ends `processed` with one case;
  - a second call reuses everything: no model call, no new rows;
  - an interaction with a valid classification but no enrichment resumes from enrich, with no model call;
  - a transient error, then success on the next call: two classification rows, one case;
  - a failure case for each failed step (mask, classify, enrich, route), with the right nullable IDs, the decision log of the finished steps and no error message text;
  - a failure case and a normal case can't both exist (the unique `interaction_id`).

## 4. Queue, intake and sweep

4.1. Write `src/queue.ts`:
  - the queue name, job options (5 attempts, exponential backoff from 10 s, `removeOnComplete` 1 day, `removeOnFail` 7 days), the sweep interval (30 s), grace period (60 s) and batch size (500), as exported constants;
  - `createQueue(redisUrl, { forIntake })`: the intake variant uses an ioredis connection with a short command timeout and `enableOfflineQueue: false`;
  - `enqueue(queue, interactionId)` with a 1-second timeout, returning `"queued" | "failed"`;
  - `sweep(db, queue, now)`: the rules in requirements.md (Queue consistency), returning counts (`added`, `readded`, `inFlight`).

  The queue name is a parameter, so each integration test file uses its own.

4.2. Intake: `buildApp` takes an `enqueue(id)` dependency. After `created` and `existing` results it calls it; a failure is logged with the ID only and doesn't change the response. `server.ts` wires the real queue (`loadApiConfig` now reads `REDIS_URL`) and closes it on shutdown. Unit tests in `test/api/interactions.test.ts` with a fake enqueue: called once per stored message; a throwing enqueue still gives `201`.

4.3. Integration tests (`test/integration/queue.int.test.ts`, real Redis and PostgreSQL):
  - intake adds a job whose data is the ID only;
  - a duplicate add with the same ID leaves one job;
  - the sweep adds a job for an old interaction with no case, ignores a fresh one (grace period) and one with a case, and re-adds after removing a `failed` job that left no case.

## 5. Worker

5.1. Write `src/worker.ts`:
  - `startWorker({ db, redisUrl, llm, queueName, concurrency, … })` returns a handle with `close()`; the processor calls `processInteraction` with `finalAttempt = job.attemptsMade + 1 >= job.opts.attempts`;
  - on an error that isn't transient, on the final attempt, the processor calls `recordFailureCase` and completes (the job doesn't need a second failure);
  - the sweep timer (at start, then every 30 s), stopped by `close()`;
  - logs: job ID, step results and outcome; never text, summaries or identifier values.

  The `main` entry checks `ANTHROPIC_API_KEY`, `DATABASE_URL` and `REDIS_URL`, prints the backlog (interactions with no case) at start, and shuts down cleanly on `SIGINT` / `SIGTERM` (finishing active jobs).

5.2. Scripts: `worker` (`tsx --env-file-if-exists=.env src/worker.ts`) and `worker:dist` for the compiled one.

5.3. Integration tests (`test/integration/worker.int.test.ts`, in-process worker, mocked LLM):
  - N stored interactions (with duplicate enqueues and an extra sweep) end as exactly N cases, with one model call each;
  - intake enqueue fails (the "crash between storing and enqueueing"), then the sweep processes the message;
  - transient errors on attempts 1–4 and success on 5 → a normal case; transient errors on all 5 → a `classification_error` case. The test uses a short backoff via the job-options parameter, not the 10 s default;
  - a non-model error on every attempt → a `processing_failed` case;
  - a worker that stops mid-job without finishing (short `lockDuration` and `stalledInterval`) → a second worker picks up the stalled job and the interaction ends with one case.

## 6. Commands and Compose

6.1. `src/cli/process.ts` (`npm run process -- <id | external_id>`): needs `ANTHROPIC_API_KEY` unless the case exists; runs `processInteraction` with `finalAttempt: true`; prints each step as reused/ran/skipped, then the case as `npm run route` does (reuse its printing). Integration test with a mocked LLM: a fresh interaction, then a re-run that makes no call.

6.2. `src/cli/queue-status.ts` (`npm run queue:status`): job counts by state, interactions by status, and the backlog the sweep would pick (count and oldest `created_at`). Integration test on a small fixture.

6.3. `docker-compose.yml`:
  - `app`: `REDIS_URL: redis://redis:6379`, and `depends_on` Redis healthy at start (it tolerates Redis going away later);
  - `worker`: same image, `command: ["node", "dist/worker.js"]`, `profiles: ["worker"]`, `DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`, `TRIAGE_MODEL`, `TRIAGE_EFFORT`, `WORKER_CONCURRENCY` from `.env`; `depends_on` migrate completed and Redis healthy; `restart: unless-stopped`.

  `.env.example` gains `WORKER_CONCURRENCY`. Check that `docker compose up -d --wait` without the profile starts no worker, and that CI is unchanged.

## 7. Redis outage tests

7.1. `test/integration/redis-outage.int.test.ts` (named so it sorts last; confirm Vitest's file order, or set `sequence` in `vitest.integration.config.ts`). A small helper runs `docker compose stop redis` / `start redis` and waits for `PING`. An `afterAll` always starts Redis again, even when a test fails.
  - **Redis down at intake:** with Redis stopped, `POST /interactions` (via `fastify.inject` with the real queue) returns `201` within about 1 second, and no job exists. After Redis starts, a sweep run processes it, and it ends with one case.
  - **A job survives a Redis restart (append-only file):** add a job with no worker running, stop and start Redis, and the job is still waiting; a worker then processes it.
  - **The worker survives a Redis outage:** with a worker running, stop Redis for a few seconds and start it again; jobs added afterwards are processed without restarting the worker.

## 8. Docs, eval and demo

8.1. Recompute the kept runs with `npm run eval:report` and regenerate the golden `test/eval/fixtures/report.md` with `UPDATE_GOLDEN=1`. Check that the diffs change only the router version.

8.2. Update [tech-stack.md](../../tech-stack.md):
  - "Queue consistency": the chosen approach (enqueue + sweep), the grace period and why not an outbox;
  - "Queue" row and "Local setup": the worker service and its profile;
  - "Data model": `interactions.status` values and the nullable `cases.classification_id`;
  - "Routing rules": `route.v2` and `processing_failed`; the "Runs" lines of routing and enrichment now say "in the worker".

8.3. Update `README.md`: starting the worker (`docker compose --profile worker up -d` or `npm run worker`), the warning that it processes every unprocessed interaction (paid), `npm run process`, `npm run queue:status`, and the async flow in the pipeline section.

8.4. Run lint, format check, type check, unit tests, build, audit, `db:migrate` and the integration tests.

8.5. Demo on a fresh, separate database `triage_demo` and Redis database 1, with the API on port 3001 (as in P07). `crm:seed`, then **after asking** (about $0.80):
  1. Start the worker, `dataset:load`, and watch `queue:status` until the backlog is 0: 100 interactions, 100 cases. Record the review count, the reason codes and the total cost from `classifications`.
  2. Stop the worker; post one message; show it waiting; start the worker; it is processed.
  3. Stop Redis; post one message (`201`); start Redis; the sweep processes it after the grace period.

  Then drop the demo database and flush Redis database 1. Keep the output for the PR description.

8.6. Record results in requirements.md (Results). Work through [validation.md](validation.md). After review, mark P08 done in [roadmap.md](../../roadmap.md), push, open the PR and ask before merging.
