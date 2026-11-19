// npm run queue:status: the processing queue at a glance (P08). Job counts by state from Redis,
// interactions by status from PostgreSQL, and the backlog: interactions with no case, which the
// worker's sweep enqueues once they are older than the grace period. Free: no model is called.

import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { loadServiceConfig } from "../config.js";
import { createDb, type Database } from "../db/database.js";
import { backlogSummary, createQueue, SWEEP_GRACE_MS, type ProcessQueue } from "../queue.js";

const JOB_STATES = ["waiting", "active", "delayed", "failed", "completed"] as const;

export async function runQueueStatus(deps: {
  db: Kysely<Database>;
  queue: ProcessQueue;
  now?: Date;
  out?: (line: string) => void;
}): Promise<number> {
  const out = deps.out ?? console.log;
  const now = deps.now ?? new Date();

  const counts = await deps.queue.getJobCounts(...JOB_STATES);
  out(`Queue "${deps.queue.name}": ${JOB_STATES.map((s) => `${s} ${counts[s] ?? 0}`).join(", ")}`);

  const byStatus = await deps.db
    .selectFrom("interactions")
    .select(["status", deps.db.fn.countAll<string>().as("n")])
    .groupBy("status")
    .orderBy("status")
    .execute();
  out(`Interactions: ${byStatus.map((r) => `${r.status} ${r.n}`).join(", ") || "none"}`);

  const all = await backlogSummary(deps.db, { before: now });
  const due = await backlogSummary(deps.db, { before: new Date(now.getTime() - SWEEP_GRACE_MS) });
  out(
    `Backlog (no case): ${all.count}` +
      (all.oldest ? `, oldest stored ${all.oldest.toISOString()}` : "") +
      `; ${due.count} older than ${SWEEP_GRACE_MS / 1000} s, which the sweep enqueues`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadServiceConfig();
  const db = createDb(config.databaseUrl);
  const { queue, close } = createQueue(config.redisUrl, { forIntake: true });
  queue
    .waitUntilReady()
    .then(() => runQueueStatus({ db, queue }))
    .then(
      (code) => (process.exitCode = code),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      },
    )
    .finally(() => void Promise.all([close(), db.destroy()]));
}
