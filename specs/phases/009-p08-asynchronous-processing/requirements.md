# Phase 8 — Asynchronous processing: Requirements

## Context

This is phase P08 in [roadmap.md](../../roadmap.md). Every pipeline step now exists, but each one runs only when someone types its command:

- P02 stores interactions through the intake API.
- P05 masks them and P03 classifies them (`npm run classify`).
- P06 enriches them (`npm run enrich`).
- P07 routes them into one case with a decision log (`npm run route`).

Nothing connects intake to the case. This phase adds the connection: intake puts a job on a queue, and a worker runs the whole pipeline in the background. It builds step 1 (Intake: "queues it for asynchronous processing") of [mission.md](../../mission.md) and the success criterion "messages are processed asynchronously from intake to case record". It serves these principles:

- **People decide the hard cases:** a message that can't be processed still ends as a case in review, never silently lost.
- **Auditable:** a failed case records which step failed.

The hard part is not the queue but the gap between two stores. Saving a message (PostgreSQL) and enqueueing its job (Redis) are two separate writes. [tech-stack.md](../../tech-stack.md) ("Queue consistency") leaves the approach to this phase.

## Scope

In scope:

- **The queue** (BullMQ on the existing Redis): one queue, `process`, with one job per interaction. The job's data is the interaction ID only, so Redis holds no message text or personal data.
- **Intake enqueues** after storing. Enqueueing is best effort: if Redis is down, the API still answers `201` and logs a warning.
- **The pipeline runner** (`src/pipeline/process.ts`, version `process.v1`): `processInteraction(id)` runs mask → classify → enrich → route. It resumes from what is stored, so a retry never repeats a step that already succeeded (see Pipeline runner).
- **The worker** (`src/worker.ts`): runs jobs with the runner, retries transient model errors, and runs the sweep.
- **The sweep:** finds interactions with no case and (re-)enqueues them. It covers a crash between storing and enqueueing, Redis being down at intake, and jobs lost inside Redis.
- **Failure cases:** a job that fails for good writes a case in review with a new reason code, `processing_failed` (`route.v2`).
- **Storage** (migration `0007`):
  - `interactions.status` gains `processed`, set in the same transaction as the case;
  - `cases.classification_id` becomes nullable, for failure cases only.
- **Docker Compose:**
  - a `worker` service under the profile `worker`, so plain `docker compose up` (and CI) never starts it;
  - the `app` service gets `REDIS_URL`.

  Redis append-only persistence and its volume are already in place (P01); this phase tests them.
- **Commands:**
  - `npm run worker`: the worker on the host;
  - `npm run process -- <id | external_id>`: the whole pipeline for one interaction, synchronously, with the same runner (paid: one model call unless already classified);
  - `npm run queue:status`: queue counts, interactions by status, and the sweep's backlog.
- **Tests:** unit tests for the runner and the retry rules with a mocked LLM; integration tests (real PostgreSQL and Redis, mocked LLM) for every failure path, including Redis stopped and started (see Validation in [validation.md](validation.md)).
- **Docs:** [tech-stack.md](../../tech-stack.md) (Queue consistency, the worker, the data model changes, `route.v2`) and the README. Approving this spec approves these edits.

Out of scope (later phases):

- Listing, confirming or correcting cases, including failure cases (P09).
- The investigating agent as a pipeline step (P10). The runner leaves a place for it between enrich and route.
- Running the injection set through the pipeline (P11).
- A queue dashboard such as Bull Board ("Ideas for later" in the roadmap).
- A budget cap for the worker. The worker refuses to start without `ANTHROPIC_API_KEY`, and Compose starts it only on request.
- A paid evaluation run. Routing changes only by the new code, which no stored output triggers.

## Queue consistency

**Approach: best-effort enqueue at intake, plus a periodic sweep.** Decided during spec review.

- **Intake** stores the interaction, then adds a job with `jobId` = the interaction ID. If Redis doesn't answer within 1 second, intake logs a warning (the ID, no text) and still returns `201`. A repeat of the same `external_id` (`200 existing`) enqueues again; BullMQ ignores the duplicate `jobId`.
- **The sweep** runs in the worker every 30 seconds, and once at start. It selects interactions with no case whose `created_at` is older than a 60-second grace period (so it doesn't race intake's own enqueue), oldest first, at most 500 per run. For each:
  - no job with that ID in Redis → add it;
  - a job that is `completed` or `failed` but left no case (for example, the failure case couldn't be written because PostgreSQL was down) → remove the old job and add it again. BullMQ ignores an `add` with an existing `jobId`, so without the removal the interaction would be stuck;
  - a job that is waiting, delayed or active → leave it.
- **Why a sweep and not an outbox table.** An outbox needs its own poller anyway, and it can't recover a job that was forwarded and then lost inside Redis. The sweep reads the one fact that matters, "this interaction has no case", straight from PostgreSQL, so it covers every way a job can go missing. A duplicate is harmless: the `jobId` collapses duplicates in Redis, and the runner is idempotent.
- **The sweep uses a timer in the worker process, not a BullMQ job scheduler.** A scheduler lives in Redis, so it would disappear with the very Redis data it is meant to recover. Two workers sweeping at once only produce duplicate adds, which are ignored.

## Pipeline runner (`process.v1`)

`processInteraction(db, llm, interactionId, { finalAttempt })` runs the steps in order. Each step first checks what is stored:

| Step | Reuses | Otherwise |
| --- | --- | --- |
| mask | the stored masking (P05 masks once) | masks and stores |
| classify | the latest **valid** classification | calls the model and stores the attempt, whatever its outcome |
| enrich | the latest enrichment made from that classification | enriches and stores |
| route | the existing case (`created: false`) | routes and writes the case |

- An interaction that already has a case returns at once, with no model call.
- An `invalid` or errored classification on the final attempt goes straight to route, which gives `general` + `invalid_output` / `classification_error` (as in P07). Enrichment is skipped, as P07 expects.
- On success the case transaction also sets `interactions.status = 'processed'`. `npm run route` (P07) does the same from now on.

## Retries and failures

### Transient model errors

Decided during spec review.

- **Inside one call:** the SDK's own retries (3, unchanged).
- **Across job attempts:** when the call still fails with a transient error, the attempt is stored (so its cost is counted) and the job fails, so BullMQ retries it. Transient errors are: connection errors and timeouts, `408`, `409`, `429`, `500` and above (including `529` overloaded). The client's failure result gains the HTTP status, so the runner can tell them apart.
- **Job options:** 5 attempts, exponential backoff starting at 10 seconds (10, 20, 40, 80 s: about 2.5 minutes in total).
- **The last attempt** doesn't throw on a transient error. It routes the errored classification, which gives a review case with `classification_error`.
- **Not retried:** other `4xx` errors, refusals, `max_tokens` and invalid output. They go to route at once and end in review, as in P07.

### Other failures

Decided during spec review.

Any other error (a database error, a bug, a missing CRM row) fails the job, and BullMQ retries it with the same options. If the **last attempt** fails too, the worker writes a **failure case**:

- team `general`, `needs_review` true, reason codes `["processing_failed"]`;
- `classification_id` and `enrichment_id` set when those steps finished, otherwise null;
- `router_version` `route.v2`;
- decision-log entries for the steps that finished, then a `route` entry whose fired rule is `processing_failed` with the detail `failed at <step>: <error class name>`. The error message is **not** stored, because a database error can quote values.

If the failure case can't be written either (for example PostgreSQL is down), the job ends `failed` with no case, and the sweep picks the interaction up again later.

A job that is stalled (its worker died mid-job) is moved back to waiting by BullMQ and runs again; the runner's reuse rules make this safe.

### `route.v2`

`route.v2` adds the reason code `processing_failed`, listed first in `REASON_CODES` (it outranks all others: nothing else was decided). It is never produced by `route()` itself; only the runner's failure path writes it. The rules for every other input are the same as `route.v1`, so the dataset-wide routing test and the eval metrics don't change except for the recorded version.

## Data

### Migration `0007`

- `interactions.status`: the check becomes `status in ('received', 'processed')`. Existing interactions that already have a case are set to `processed`.
- `cases.classification_id`: nullable. A new check allows null only on a failure case: `classification_id is not null or reason_codes ? 'processing_failed'`.

`rollback` restores both checks; it fails if a failure case with a null `classification_id` exists, which is expected for a development rollback.

### Redis

- Job data: `{ interactionId }` only.
- Completed jobs are kept for 1 day, failed jobs for 7 days (`removeOnComplete` / `removeOnFail` by age). The sweep doesn't depend on them: it asks PostgreSQL whether a case exists.
- The intake's Redis connection has a short command timeout and no offline queue, so a Redis outage can't hang a request. The worker's connection keeps BullMQ's required `maxRetriesPerRequest: null`.

## Configuration

| Variable | Used by | Default |
| --- | --- | --- |
| `REDIS_URL` | API (new), worker, `queue:status` | required |
| `ANTHROPIC_API_KEY` | worker, `process` | required; the worker exits with a message without it |
| `WORKER_CONCURRENCY` | worker | `4` |
| `TRIAGE_MODEL`, `TRIAGE_EFFORT` | worker, `process` | as in P03 |

The sweep interval, grace period and job options are constants in `src/queue.ts`, not variables: they are part of the tested behaviour.

## Decisions

### Requirements

| Decision | Choice | Why |
| --- | --- | --- |
| Queue consistency | Best-effort enqueue at intake + a periodic sweep for interactions with no case; `jobId` = interaction ID | One source of truth (PostgreSQL), no extra table, and it also recovers jobs lost inside Redis. Decided during spec review. |
| Transient model errors | SDK retries, then job retries (5 attempts, exponential backoff from 10 s); the last attempt routes the error to review | A short API outage doesn't send every message to review, and the case still always ends. Decided during spec review. |
| Non-model failures | After the last attempt, a failure case: `general`, `processing_failed` (`route.v2`), nullable `classification_id` | Keeps "every interaction ends as exactly one case" literally true and puts failures in P09's review queue. Decided during spec review. |
| Commands | `npm run process` and `npm run queue:status`, besides `npm run worker` | The synchronous command reuses the runner for debugging and the demo; the status command shows the backlog. Decided during spec review. |
| Redis contents | Interaction IDs only | Personal data stays in PostgreSQL; Redis needs no masking. |

### Plan

| Decision | Choice | Why |
| --- | --- | --- |
| Where the worker runs | A Compose service under the profile `worker` (same image, `node dist/worker.js`), plus `npm run worker` | The worker spends money on every message, so it starts only on request; CI's `docker compose up --wait` never starts it. Decided during spec review. |
| Job shape | One `process` job per interaction, running all steps; each step reuses what is stored | A retry never pays twice for a classification that succeeded, and there is no partial state between jobs. Decided during spec review. |
| Sweep trigger | A timer in the worker, not a BullMQ job scheduler | A scheduler lives in Redis and would vanish with the data it should recover. |
| `npm run process` | Runs as the final attempt | It always ends with a case, as a person running it expects. |

### Validation

| Decision | Choice | Why |
| --- | --- | --- |
| Demo | The full dataset (100 paid classify calls, about $0.80) on a separate demo database, after asking | Matches the roadmap's demo literally. Decided during spec review. |
| Failure tests | Every failure path is an automated integration test, **including Redis stopped and started** | Decided during spec review. See the note on Docker control below. |

## Notes

- **The Redis-down tests control Docker.** They run `docker compose stop redis` and `docker compose start redis` (waiting until it is healthy) from the test file. They live in their own file, `test/integration/redis-outage.int.test.ts`, which runs last (integration files already run one after another). In CI this works because the integration job uses the same Compose file. They need the `docker` CLI on the machine running the tests, which `npm run test:integration` already assumes.
- **Starting the worker on the development database is paid.** The sweep processes every interaction with no case: about 100 from the dataset loads of earlier phases, about $0.80. The demo uses a separate database (as in P06 and P07); the README warns about this.
- **The demo needs its own queue.** The demo API and worker point at Redis database 1 (`redis://localhost:6379/1`), so jobs for the demo database never reach a worker on the development database.
- **`route.v2` changes the recorded version in the eval reports.** The kept runs are recomputed with `npm run eval:report`; only the version line should change. The golden fixture `test/eval/fixtures/report.md` changes the same way.
- **`processing_failed` is first in `REASON_CODES`.** This changes the order constant that P07's tests use; the reason codes of existing cases don't change.
- **Intake latency.** Enqueueing adds one Redis round trip to `POST /interactions`. With Redis down, a request waits up to the 1-second timeout.
- Docs consulted: BullMQ (`/taskforcesh/bullmq`, v6): custom job IDs and duplicates, `removeOnComplete` and duplicates, retries with exponential backoff.

## Implementation notes

- **The runner writes failure cases, not the worker.** The plan had the worker call `recordFailureCase` on the last attempt. `processInteraction` does it instead when `finalAttempt` is true, so `npm run process` behaves the same as the worker, and the worker's processor stays one call. The job then completes (it has a case); only an error while writing the failure case fails the job, and the sweep picks the interaction up again.
- **A stored `invalid` attempt is reused.** The spec reused only a valid classification. If an earlier attempt stored invalid output and the job then failed before writing the case, a retry would pay again for an answer that goes to review anyway. The runner now reuses the latest attempt when it is `invalid`; an `error` attempt is still re-called.
- **An error attempt with no known status isn't retried.** `isTransient` retries `apiStatus: null` (connection error or timeout) but not an attempt without `apiStatus` at all, which didn't come from the API client.
- **The eval reports gained a row.** Besides the router version, the reason-code table lists `processing_failed` with 0, like `investigation_inconclusive`, because it iterates `REASON_CODES`. No metric changed.
- **Redis must be up when the API starts.** BullMQ can't create a fail-fast producer queue while Redis is down, so the server awaits `queue.waitUntilReady()` and the Compose `app` service now waits for Redis to be healthy. After start, intake tolerates outages (tested).
- **The outage tests run last through a small Vitest sequencer** in `vitest.integration.config.ts`: Vitest orders files by cached duration, not by name, so a file name alone can't guarantee the order.
- **Shared printing.** `npm run process` prints the case with the route CLI's `printCase`, now exported.
- **The sweep goes oldest first by ID** (uuidv7, time-ordered and indexed), not by `created_at`.
- **The spec files were committed with group 1**, not in a commit of their own.

## Results (recorded during implementation)

- **Tests:** 722 unit tests and 135 integration tests pass locally, including the 3 Redis outage tests (each stops and starts the Compose Redis, about 10 seconds for the file). The worker and outage files passed on repeated runs.
- **Kept runs recomputed** with `npm run eval:report`: only the router version (`route.v2`) and a `processing_failed | 0` row changed in each report; `outputs.jsonl` and `run.json` are unchanged.
- **Demo** on a separate `triage_demo` database with Redis database 1 and the API on port 3001, after `crm:seed`; dropped and flushed afterwards. The development database was not touched.

  1. Worker started (backlog 0), then `dataset:load`: **100 interactions, 100 cases, 0 left in the backlog, 54 seconds** from the first message stored to the last case written (concurrency 4; 2.2 to 53.8 seconds per message, waiting included).

     | | |
     | --- | --- |
     | Classifications | 100, all valid, average latency 2.1 s |
     | Cost | $0.649 for the 100 (about $0.0065 per message) |
     | Sent to review | 57 of 100 (the kept `classify.v2` run: 56) |
     | Teams | 17 each for complaints, billing, technical support and sales; 16 each for general and retention |

     | Reason code | Cases |
     | --- | --- |
     | `complaint` | 17 |
     | `cancellation` | 16 |
     | `low_confidence` | 9 |
     | `customer_unidentified` | 9 |
     | `customer_ambiguous` | 5 |
     | `customer_not_found` | 5 |
     | `crm_mismatch_unmatched_key` | 3 |

  2. **Worker stopped** (`SIGINT`: "finishing active jobs"), one message posted: `queue:status` showed it waiting. After the worker started again, it was processed within seconds (`technical_support`, `customer_unidentified`: a fault with no account number).
  3. **Redis stopped**, one message posted: `201` in 0.02 s, and the API logged "enqueue failed" with the interaction ID only. After Redis started, the worker's sweep enqueued it ("added": 1) once it was past the 60-second grace period: the case was written 74 seconds after the message was stored (`retention`, `cancellation`).

  Total demo cost: **$0.669** for 102 classifications.
