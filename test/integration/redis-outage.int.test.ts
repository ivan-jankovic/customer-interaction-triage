// Redis outages (P08): these tests stop and start the Compose Redis with `docker compose`, so
// they need the docker CLI (as `npm run test:integration` already does) and run after every
// other integration file (see the sequencer in vitest.integration.config.ts). Redis is always
// started again afterwards, even when a test fails. No model is called.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";
import { loadServiceConfig } from "../../src/config.js";
import { readCase } from "../../src/db/cases.js";
import { seedCrm } from "../../src/db/crm.js";
import type { Database } from "../../src/db/database.js";
import { KyselyInteractionStore } from "../../src/db/interactions.js";
import { createQueue, enqueue, JOB_OPTIONS, type ProcessQueue } from "../../src/queue.js";
import { startWorker, type WorkerHandle } from "../../src/worker.js";
import { byMaskedText, processDeps, record, scriptedLlm, seed, storeMessage } from "../support/pipeline.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const run = promisify(execFile);
const { redisUrl } = loadServiceConfig();
const KEY = "outage-test-key-0123456789abcdef0123";
const FAST_JOBS = { ...JOB_OPTIONS, backoff: { type: "fixed", delay: 20 } } as const;

let testDb: TestDatabase;
let db: Kysely<Database>;
const cleanups: (() => Promise<void>)[] = [];

async function compose(...args: string[]): Promise<void> {
  await run("docker", ["compose", ...args], { cwd: process.cwd() });
}

/** Resolves once Redis answers PING (fresh connection each try). */
async function waitForRedis(timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const probe = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1_000 });
    probe.on("error", () => {});
    try {
      await probe.connect();
      if ((await probe.ping()) === "PONG") return;
    } catch {
      // not up yet
    } finally {
      probe.disconnect();
    }
    if (Date.now() > until) throw new Error("Redis did not come back");
    await new Promise((r) => setTimeout(r, 200));
  }
}

const stopRedis = () => compose("stop", "redis");
async function startRedis(): Promise<void> {
  await compose("start", "redis");
  await waitForRedis();
}

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const queueName = () => `test-outage-${randomBytes(4).toString("hex")}`;

function worker(name: string, messageIds: string[]): WorkerHandle {
  const handle = startWorker({
    db,
    redisUrl,
    deps: processDeps(scriptedLlm(["valid"], byMaskedText(messageIds))),
    queueName: name,
    jobOptions: FAST_JOBS,
    sweepIntervalMs: 500,
    sweepGraceMs: 0,
    log: () => {},
  });
  cleanups.push(async () => {
    await handle.queue.obliterate({ force: true }).catch(() => {});
    await handle.close(true);
  });
  return handle;
}

function producer(name: string): ProcessQueue {
  const { queue, close } = createQueue(redisUrl, { name, forIntake: true, jobOptions: FAST_JOBS });
  cleanups.push(close);
  return queue;
}

beforeAll(async () => {
  await waitForRedis();
  testDb = await createTestDatabase({ migrate: true });
  db = testDb.db;
  await seedCrm(db, seed);
});

afterEach(async () => {
  // Redis first, so the cleanups can reach it.
  await startRedis();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

afterAll(async () => {
  await startRedis();
  await testDb?.drop();
});

describe("Redis outage", () => {
  it("intake still answers 201 while Redis is down; the sweep processes the message afterwards", async () => {
    const name = queueName();
    const queue = producer(name);
    await queue.waitUntilReady();
    const app: FastifyInstance = buildApp({
      store: new KyselyInteractionStore(db),
      apiKey: KEY,
      checkDb: () => Promise.resolve(),
      enqueue: (id) => enqueue(queue, id),
    });
    cleanups.push(() => app.close());

    await stopRedis();
    const r = record("msg-011");
    const started = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/interactions",
      headers: { "x-api-key": KEY },
      payload: { external_id: `outage-${randomBytes(4).toString("hex")}`, channel: r.channel, text: r.text },
    });
    expect(res.statusCode).toBe(201);
    expect(Date.now() - started).toBeLessThan(1_500);
    const id = res.json<{ id: string }>().id;

    await startRedis();
    // The job was never added. (The intake connection needs a moment to reconnect; until then it fails fast.)
    const lookup = await waitFor(async () => {
      try {
        return { job: await queue.getJob(id) };
      } catch {
        return null;
      }
    });
    expect(lookup.job).toBeUndefined();
    worker(name, ["msg-011"]); // its sweep finds the interaction
    const c = await waitFor(() => readCase(db, id));
    expect(c.reasonCodes).toEqual([]);
  }, 90_000);

  it("keeps a waiting job across a Redis restart (append-only file)", async () => {
    const name = queueName();
    const queue = producer(name);
    await queue.waitUntilReady();
    const id = await storeMessage(db, "msg-011");
    expect(await enqueue(queue, id)).toBe("queued");

    await stopRedis();
    await startRedis();
    const job = await waitFor(async () => (await queue.getJob(id).catch(() => undefined)) ?? null);
    expect(await job.getState()).toBe("waiting");

    worker(name, ["msg-011"]);
    await waitFor(() => readCase(db, id));
  }, 90_000);

  it("a running worker resumes after Redis comes back, without a restart", async () => {
    const name = queueName();
    const handle = worker(name, ["msg-011", "msg-022"]);
    const before = await storeMessage(db, "msg-011");
    await enqueue(handle.queue, before);
    await waitFor(() => readCase(db, before));

    await stopRedis();
    await new Promise((r) => setTimeout(r, 2_000));
    await startRedis();

    const after = await storeMessage(db, "msg-022");
    // The worker's own queue reconnects too; enqueue is retried until it does.
    await waitFor(async () => (await enqueue(handle.queue, after)) === "queued");
    const c = await waitFor(() => readCase(db, after), 30_000);
    expect(c).toBeDefined();
  }, 90_000);
});
