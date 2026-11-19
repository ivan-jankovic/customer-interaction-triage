// The processing queue and the sweep (P08) against the Compose Redis and a throwaway database.
// The queue has its own name, so nothing here reaches a worker on the development queue.

import { randomBytes } from "node:crypto";
import { Worker } from "bullmq";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadServiceConfig } from "../../src/config.js";
import type { Database } from "../../src/db/database.js";
import { createRedis } from "../../src/redis.js";
import { createQueue, enqueue, JOB_OPTIONS, sweep, SWEEP_GRACE_MS, type ProcessQueue } from "../../src/queue.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const NAME = `test-queue-${randomBytes(4).toString("hex")}`;
const { redisUrl } = loadServiceConfig();
let testDb: TestDatabase;
let db: Kysely<Database>;
let queue: ProcessQueue;
let closeQueue: () => Promise<void>;

async function storeInteraction(createdAgoMs: number): Promise<string> {
  const { id } = await db
    .insertInto("interactions")
    .values({ channel: "chat", raw_text: "Dobrý den", created_at: new Date(Date.now() - createdAgoMs) })
    .returning("id")
    .executeTakeFirstOrThrow();
  return id;
}

const OLD = SWEEP_GRACE_MS + 5_000;

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
  db = testDb.db;
  ({ queue, close: closeQueue } = createQueue(redisUrl, { name: NAME, forIntake: true }));
  await queue.waitUntilReady();
});

beforeEach(async () => {
  await queue.obliterate({ force: true });
  await sql`truncate interactions cascade`.execute(db);
});

afterAll(async () => {
  await queue?.obliterate({ force: true });
  await closeQueue?.();
  await testDb?.drop();
});

describe("enqueue", () => {
  it("adds one job whose ID is the interaction ID and whose data is that ID only", async () => {
    const id = await storeInteraction(0);
    expect(await enqueue(queue, id)).toBe("queued");
    const job = await queue.getJob(id);
    expect(job?.id).toBe(id);
    expect(job?.data).toEqual({ interactionId: id });
    expect(job?.opts).toMatchObject({ attempts: JOB_OPTIONS.attempts, backoff: JOB_OPTIONS.backoff });
  });

  it("keeps one job when the same interaction is enqueued twice", async () => {
    const id = await storeInteraction(0);
    await enqueue(queue, id);
    await enqueue(queue, id);
    expect(await queue.getJobCounts("waiting")).toEqual({ waiting: 1 });
  });

  it("fails fast, without throwing, when Redis can't be reached", async () => {
    const unreachable = createQueue("redis://127.0.0.1:1", { name: NAME, forIntake: true });
    const started = Date.now();
    expect(await enqueue(unreachable.queue, "0190e9a0-0000-7000-8000-000000000000")).toBe("failed");
    expect(Date.now() - started).toBeLessThan(2_000);
    await unreachable.close();
  });
});

describe("sweep", () => {
  it("adds old interactions with no case, and skips fresh ones and ones with a case", async () => {
    const old = await storeInteraction(OLD);
    const fresh = await storeInteraction(1_000);
    const withCase = await storeInteraction(OLD);
    await sql`insert into cases (interaction_id, target_team, needs_review, reason_codes, router_version)
              values (${withCase}, 'general', true, '["processing_failed"]', 'route.v2')`.execute(db);

    expect(await sweep(db, queue)).toEqual({ added: 1, readded: 0, inFlight: 0 });
    expect(await queue.getJob(old)).toBeDefined();
    expect(await queue.getJob(fresh)).toBeUndefined();
    expect(await queue.getJob(withCase)).toBeUndefined();

    // A second sweep leaves the waiting job alone.
    expect(await sweep(db, queue)).toEqual({ added: 0, readded: 0, inFlight: 1 });
    expect(await queue.getJobCounts("waiting")).toEqual({ waiting: 1 });
  });

  it("re-adds an interaction whose failed job left no case", async () => {
    const id = await storeInteraction(OLD);
    await queue.add("process", { interactionId: id }, { jobId: id, attempts: 1 });
    const connection = createRedis(redisUrl);
    const worker = new Worker(
      NAME,
      () => {
        throw new Error("PostgreSQL is down");
      },
      { connection },
    );
    worker.on("error", () => {});
    await new Promise<void>((resolve) => worker.once("failed", () => resolve()));
    await worker.close();
    connection.disconnect();
    expect(await (await queue.getJob(id))!.getState()).toBe("failed");

    expect(await sweep(db, queue)).toEqual({ added: 0, readded: 1, inFlight: 0 });
    expect(await (await queue.getJob(id))!.getState()).toBe("waiting");
  });

  it("takes at most the batch size, oldest first", async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await storeInteraction(OLD + (3 - i) * 1000));
    expect(await sweep(db, queue, { limit: 2 })).toMatchObject({ added: 2 });
    expect(await queue.getJob(ids[0]!)).toBeDefined();
    expect(await queue.getJob(ids[2]!)).toBeUndefined();
  });
});
