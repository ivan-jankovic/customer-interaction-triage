// The processing queue (P08 requirements.md, "Queue consistency"): one BullMQ queue with one job
// per interaction. The job ID is the interaction ID, so adding the same interaction twice
// leaves one job, and the job data is that ID only: Redis never holds message text.
//
// Every stored interaction is eventually processed even if enqueueing fails (Redis down, or a
// crash between the PostgreSQL write and the Redis write): the sweep reads "no case yet" from
// PostgreSQL and enqueues again. A timer in the worker runs it, not a BullMQ job scheduler,
// because a scheduler lives in Redis and would vanish with the data it should recover.

import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { sql, type Kysely } from "kysely";
import type { Database } from "./db/database.js";

export const QUEUE_NAME = "process";
export const JOB_NAME = "process";

/** 5 attempts, exponential backoff from 10 s (10, 20, 40, 80 s: about 2.5 minutes in all). */
export const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 10_000 },
  // The sweep doesn't depend on these: it asks PostgreSQL whether a case exists.
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const satisfies JobsOptions;

export const SWEEP_INTERVAL_MS = 30_000;
/** Interactions younger than this are left to intake's own enqueue, so the sweep doesn't race it. */
export const SWEEP_GRACE_MS = 60_000;
export const SWEEP_BATCH = 500;
/** How long intake waits for Redis before answering without a job. */
export const ENQUEUE_TIMEOUT_MS = 1_000;

export interface ProcessJobData {
  interactionId: string;
}

export type ProcessQueue = Queue<ProcessJobData>;

/**
 * A queue for adding jobs. For intake, the connection fails fast instead of waiting for Redis
 * (no offline queue, one retry, a command timeout), so an outage can't hang a request; the
 * sweep enqueues the message later. BullMQ needs Redis up when the queue is created, so call
 * `waitUntilReady()` at start; the queue reconnects by itself after a later outage.
 */
export function createQueue(
  redisUrl: string,
  {
    name = QUEUE_NAME,
    forIntake = false,
    jobOptions = JOB_OPTIONS,
  }: { name?: string; forIntake?: boolean; /** Tests pass a short backoff. */ jobOptions?: JobsOptions } = {},
): { queue: ProcessQueue; close: () => Promise<void> } {
  const connection = forIntake
    ? new Redis(redisUrl, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        commandTimeout: ENQUEUE_TIMEOUT_MS,
        connectTimeout: 2_000,
      })
    : new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<ProcessJobData>(name, { connection, defaultJobOptions: jobOptions });
  // Without a listener an 'error' event would crash the process; the outage is reported where
  // a call fails instead.
  queue.on("error", () => {});
  connection.on("error", () => {});
  return {
    queue,
    close: async () => {
      await queue.close();
      connection.disconnect();
    },
  };
}

/** Adds the job of an interaction (a no-op when one with its ID exists). Never throws. */
export async function enqueue(
  queue: ProcessQueue,
  interactionId: string,
  timeoutMs = ENQUEUE_TIMEOUT_MS,
): Promise<"queued" | "failed"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("enqueue timed out")), timeoutMs);
    });
    await Promise.race([queue.add(JOB_NAME, { interactionId }, { jobId: interactionId }), timeout]);
    return "queued";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

export interface SweepResult {
  /** No job existed: added. */
  added: number;
  /** A completed or failed job left no case: removed and added again. */
  readded: number;
  /** A job is waiting, delayed or running: left alone. */
  inFlight: number;
}

/** Interactions with no case stored before the grace period, oldest first (the sweep's backlog). */
export async function unprocessedInteractions(
  db: Kysely<Database>,
  { before, limit }: { before: Date; limit: number },
): Promise<{ id: string; created_at: Date }[]> {
  return db
    .selectFrom("interactions")
    .select(["id", "created_at"])
    .where("created_at", "<", before)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("cases")
            .select(sql`1`.as("one"))
            .whereRef("cases.interaction_id", "=", "interactions.id"),
        ),
      ),
    )
    .orderBy("id")
    .limit(limit)
    .execute();
}

/**
 * Enqueues every interaction that has no case and is older than the grace period. BullMQ
 * ignores an add with an existing job ID, so a completed or failed job that left no case (for
 * example, the failure case couldn't be written because PostgreSQL was down) is removed first.
 */
export async function sweep(
  db: Kysely<Database>,
  queue: ProcessQueue,
  { now = new Date(), graceMs = SWEEP_GRACE_MS, limit = SWEEP_BATCH } = {},
): Promise<SweepResult> {
  const result: SweepResult = { added: 0, readded: 0, inFlight: 0 };
  const backlog = await unprocessedInteractions(db, { before: new Date(now.getTime() - graceMs), limit });
  for (const { id } of backlog) {
    const job = await queue.getJob(id);
    if (job) {
      const state = await job.getState();
      if (state !== "completed" && state !== "failed" && state !== "unknown") {
        result.inFlight++;
        continue;
      }
      await job.remove();
      await queue.add(JOB_NAME, { interactionId: id }, { jobId: id });
      result.readded++;
    } else {
      await queue.add(JOB_NAME, { interactionId: id }, { jobId: id });
      result.added++;
    }
  }
  return result;
}

/** How many interactions have no case, and the oldest one's created_at (for `npm run queue:status`). */
export async function backlogSummary(
  db: Kysely<Database>,
  { before = new Date() }: { before?: Date } = {},
): Promise<{ count: number; oldest: Date | null }> {
  const r = await sql<{ n: string; oldest: Date | null }>`
    select count(*) as n, min(i.created_at) as oldest
    from interactions i
    where i.created_at < ${before}
      and not exists (select 1 from cases c where c.interaction_id = i.id)`.execute(db);
  return { count: Number(r.rows[0]!.n), oldest: r.rows[0]!.oldest };
}
