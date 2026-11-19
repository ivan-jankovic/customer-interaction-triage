// The queue worker (P08): runs the pipeline for each `process` job and sweeps for interactions
// that have no case (src/queue.ts). `npm run worker`, or the Compose `worker` service, which
// starts only with `--profile worker` because every message it processes is a paid model call.
//
// Retries: a transient model error on a non-final attempt throws TransientModelError, so BullMQ
// retries the job with backoff. On the last attempt the runner never throws for a model error,
// and writes a failure case (processing_failed) for any other error (src/pipeline/process.ts).
// A job whose worker died is moved back to waiting by BullMQ (stalled) and runs again; the
// runner reuses every step that finished.
//
// Logs are JSON lines with IDs, step results, teams and reason codes only: never message text,
// summaries, identifier values or error messages (a database error can quote values).

import { fileURLToPath } from "node:url";
import { Worker, type Job, type JobsOptions, type WorkerOptions } from "bullmq";
import type { Kysely } from "kysely";
import { loadWorkerConfig } from "./config.js";
import { errorClassName } from "./db/cases.js";
import { createDb, type Database } from "./db/database.js";
import { createAnthropicClient } from "./llm/client.js";
import { loadPrompt } from "./llm/prompts.js";
import { processInteraction, TransientModelError, type ProcessDeps } from "./pipeline/process.js";
import { CLASSIFY_PROMPT_VERSION } from "./pipeline/understand.js";
import {
  createQueue,
  JOB_OPTIONS,
  QUEUE_NAME,
  sweep,
  SWEEP_GRACE_MS,
  SWEEP_INTERVAL_MS,
  unprocessedInteractions,
  type ProcessJobData,
  type ProcessQueue,
  type SweepResult,
} from "./queue.js";
import { createRedis } from "./redis.js";

export type Log = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

export const jsonLog: Log = (level, msg, fields = {}) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === "info") console.log(line);
  else console.error(line);
};

export interface StartWorkerOptions {
  db: Kysely<Database>;
  redisUrl: string;
  deps: ProcessDeps;
  queueName?: string;
  concurrency?: number;
  /** Options of the jobs the sweep adds; tests pass a short backoff. */
  jobOptions?: JobsOptions;
  sweepIntervalMs?: number;
  sweepGraceMs?: number;
  /** BullMQ worker options such as lockDuration and stalledInterval (tests). */
  workerOptions?: Partial<Omit<WorkerOptions, "connection" | "concurrency">>;
  log?: Log;
}

export interface WorkerHandle {
  worker: Worker<ProcessJobData>;
  /** The queue the sweep adds to; tests also add jobs through it. */
  queue: ProcessQueue;
  /** Runs one sweep now (also run at start and on the timer). */
  sweepNow(): Promise<SweepResult>;
  /** Stops the sweep, waits for active jobs (unless forced) and closes the connections. */
  close(force?: boolean): Promise<void>;
}

export function startWorker(options: StartWorkerOptions): WorkerHandle {
  const {
    db,
    redisUrl,
    deps,
    queueName = QUEUE_NAME,
    concurrency = 4,
    jobOptions = JOB_OPTIONS,
    sweepIntervalMs = SWEEP_INTERVAL_MS,
    sweepGraceMs = SWEEP_GRACE_MS,
    log = jsonLog,
  } = options;

  const connection = createRedis(redisUrl);
  connection.on("error", () => {}); // reported by BullMQ's own error events below
  const { queue, close: closeQueue } = createQueue(redisUrl, { name: queueName, jobOptions });

  const processor = async (job: Job<ProcessJobData>) => {
    const attempts = job.opts.attempts ?? 1;
    const finalAttempt = job.attemptsMade + 1 >= attempts;
    const r = await processInteraction(db, deps, job.data.interactionId, { finalAttempt });
    log(r.failure ? "warn" : "info", r.failure ? "processing failed; failure case written" : "processed", {
      jobId: job.id,
      attempt: job.attemptsMade + 1,
      caseId: r.case.id,
      created: r.case.created,
      steps: r.steps,
      team: r.case.targetTeam,
      needsReview: r.case.needsReview,
      reasonCodes: r.case.reasonCodes,
      ...(r.failure ? { failedStep: r.failure.step, errorClass: r.failure.errorClass } : {}),
    });
    return { caseId: r.case.id };
  };

  const worker = new Worker<ProcessJobData>(queueName, processor, {
    connection,
    concurrency,
    ...options.workerOptions,
  });
  worker.on("failed", (job, error) => {
    log("warn", "job attempt failed", {
      jobId: job?.id,
      attempt: job?.attemptsMade,
      errorClass: errorClassName(error),
      // A transient model error's message is the API's, with no customer data; others aren't logged.
      ...(error instanceof TransientModelError ? { error: error.message } : {}),
    });
  });
  worker.on("error", (error) => log("error", "worker error", { errorClass: errorClassName(error) }));

  let sweeping: Promise<SweepResult> | null = null;
  const sweepNow = () => {
    // Runs never overlap; a call during a sweep waits for it.
    sweeping ??= sweep(db, queue, { graceMs: sweepGraceMs }).finally(() => (sweeping = null));
    return sweeping;
  };
  const sweepAndLog = () => {
    sweepNow().then(
      (r) => {
        if (r.added + r.readded > 0) log("info", "sweep enqueued interactions", { ...r });
      },
      // Redis or PostgreSQL down: the next sweep tries again.
      (error: unknown) => log("warn", "sweep failed", { errorClass: errorClassName(error) }),
    );
  };
  sweepAndLog();
  const timer = setInterval(sweepAndLog, sweepIntervalMs);

  return {
    worker,
    queue,
    sweepNow,
    async close(force = false) {
      clearInterval(timer);
      await sweeping?.catch(() => {});
      await worker.close(force);
      await closeQueue();
      connection.disconnect();
    },
  };
}

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const db = createDb(config.databaseUrl);
  const backlog = await unprocessedInteractions(db, { before: new Date(), limit: 10_000 });
  jsonLog("info", "worker starting", {
    model: config.model,
    effort: config.effort,
    concurrency: config.concurrency,
    // Every one of these is a paid classification unless it was classified before.
    backlog: backlog.length,
  });
  const handle = startWorker({
    db,
    redisUrl: config.redisUrl,
    deps: {
      llm: createAnthropicClient(),
      model: config.model,
      effort: config.effort,
      prompt: loadPrompt(CLASSIFY_PROMPT_VERSION),
    },
    concurrency: config.concurrency,
  });

  const shutdown = (signal: string) => {
    jsonLog("info", `${signal} received; finishing active jobs`);
    handle
      .close()
      .then(() => db.destroy())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          jsonLog("error", "shutdown failed", { errorClass: errorClassName(error) });
          process.exit(1);
        },
      );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    // Configuration errors are written for people (e.g. the missing ANTHROPIC_API_KEY).
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
