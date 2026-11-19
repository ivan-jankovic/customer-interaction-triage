// The queue worker (P08) in-process, against the Compose Redis and a throwaway database, with a
// scripted model client: no model calls. Each test uses its own queue name and a short backoff.

import { randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadServiceConfig } from "../../src/config.js";
import { readCase } from "../../src/db/cases.js";
import { seedCrm } from "../../src/db/crm.js";
import type { Database } from "../../src/db/database.js";
import type { LlmClient } from "../../src/llm/client.js";
import { JOB_OPTIONS, enqueue } from "../../src/queue.js";
import { startWorker, type Log, type StartWorkerOptions, type WorkerHandle } from "../../src/worker.js";
import {
  byMaskedText,
  processDeps,
  record,
  scriptedLlm,
  seed,
  storeMessage,
  type Answer,
} from "../support/pipeline.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const { redisUrl } = loadServiceConfig();
const FAST_JOBS = { ...JOB_OPTIONS, backoff: { type: "fixed", delay: 20 } } as const;
const MESSAGES = ["msg-011", "msg-013", "msg-022", "msg-007", "msg-082"];

let testDb: TestDatabase;
let db: Kysely<Database>;
const handles: WorkerHandle[] = [];
const logLines: string[] = [];
const captureLog: Log = (level, msg, fields) => logLines.push(JSON.stringify({ level, msg, ...fields }));

function start(llm: LlmClient, options: Partial<StartWorkerOptions> = {}): WorkerHandle {
  const handle = startWorker({
    db,
    redisUrl,
    deps: processDeps(llm),
    queueName: `test-worker-${randomBytes(4).toString("hex")}`,
    jobOptions: FAST_JOBS,
    // Tests run sweeps themselves unless they set an interval.
    sweepIntervalMs: 3_600_000,
    sweepGraceMs: 0,
    log: captureLog,
    ...options,
  });
  handles.push(handle);
  return handle;
}

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const waitForCase = (id: string) => waitFor(() => readCase(db, id));
const count = async (table: "classifications" | "cases", ids: string[]) =>
  Number(
    (
      await sql<{ n: string }>`select count(*) as n from ${sql.table(table)}
                               where interaction_id = any(${ids}::uuid[])`.execute(db)
    ).rows[0]!.n,
  );

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
  db = testDb.db;
  await seedCrm(db, seed);
});

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.queue.obliterate({ force: true }).catch(() => {});
    await h.close(true);
  }
});

afterAll(async () => {
  await testDb?.drop();
});

describe("worker", () => {
  it("ends N interactions as exactly N cases with one model call each, despite duplicates", async () => {
    const llm = scriptedLlm(["valid"], byMaskedText(MESSAGES));
    // Stored before the worker starts, so its start-up sweep sees them too.
    const ids = [];
    for (const m of MESSAGES) ids.push(await storeMessage(db, m));
    const h = start(llm, { concurrency: 3 });
    for (const id of ids) {
      await enqueue(h.queue, id);
      await enqueue(h.queue, id);
    }
    await h.sweepNow();
    for (const id of ids) await waitForCase(id);
    await h.sweepNow(); // nothing left to do
    expect(await count("cases", ids)).toBe(MESSAGES.length);
    expect(llm.calls).toHaveLength(MESSAGES.length);
    expect(await count("classifications", ids)).toBe(MESSAGES.length);
  });

  it("processes a message whose enqueue never happened (crash between storing and enqueueing)", async () => {
    const id = await storeMessage(db, "msg-011");
    // No enqueue: the worker's sweep timer finds it.
    start(scriptedLlm(["valid"], byMaskedText(["msg-011"])), { sweepIntervalMs: 200 });
    const c = await waitForCase(id);
    expect(c.reasonCodes).toEqual([]);
  });

  it("retries transient errors and ends with a normal case when attempt 5 succeeds", async () => {
    const script: Answer[] = [{ status: 529 }, { status: 429 }, { status: null }, { status: 503 }, "valid"];
    const llm = scriptedLlm(script, byMaskedText(["msg-011"]));
    const id = await storeMessage(db, "msg-011");
    const h = start(llm);
    await enqueue(h.queue, id);
    const c = await waitForCase(id);
    expect(c.reasonCodes).toEqual([]);
    expect(llm.calls).toHaveLength(5);
    expect(await count("classifications", [id])).toBe(5);
  });

  it("sends the case to review (classification_error) when every attempt has a transient error", async () => {
    const llm = scriptedLlm([{ status: 529 }], byMaskedText(["msg-011"]));
    const id = await storeMessage(db, "msg-011");
    const h = start(llm);
    await enqueue(h.queue, id);
    const c = await waitForCase(id);
    expect(c).toMatchObject({ targetTeam: "general", needsReview: true, reasonCodes: ["classification_error"] });
    expect(llm.calls).toHaveLength(JOB_OPTIONS.attempts);
  });

  it("writes a processing_failed case when a non-model error lasts to the last attempt", async () => {
    const llm = scriptedLlm(["throw"], byMaskedText(["msg-011"]));
    const id = await storeMessage(db, "msg-011");
    const h = start(llm);
    await enqueue(h.queue, id);
    const c = await waitForCase(id);
    expect(c).toMatchObject({ classificationId: null, reasonCodes: ["processing_failed"] });
    expect(llm.calls).toHaveLength(JOB_OPTIONS.attempts);
    const job = await h.queue.getJob(id);
    expect(await job!.getState()).toBe("completed");
  });

  it("recovers a stalled job when its worker stops mid-job", async () => {
    const id = await storeMessage(db, "msg-011");
    const stall = { lockDuration: 1_000, stalledInterval: 300 };
    // Worker A hangs inside the model call, then stops without finishing (as if it crashed).
    let started!: () => void;
    const inCall = new Promise<void>((resolve) => (started = resolve));
    const hanging: LlmClient = {
      complete: () => {
        started();
        return new Promise(() => {});
      },
    };
    const queueName = `test-worker-${randomBytes(4).toString("hex")}`;
    const a = start(hanging, { queueName, workerOptions: stall });
    await enqueue(a.queue, id);
    await inCall;
    await a.close(true);
    handles.splice(handles.indexOf(a), 1);

    const llm = scriptedLlm(["valid"], byMaskedText(["msg-011"]));
    start(llm, { queueName, workerOptions: stall });
    const c = await waitForCase(id);
    expect(c.reasonCodes).toEqual([]);
    expect(await count("cases", [id])).toBe(1);
  });

  it("logs no message text, summary or identifier value", async () => {
    logLines.length = 0;
    const ids = [];
    const llm = scriptedLlm(["valid"], byMaskedText(["msg-055", "msg-022"]));
    const h = start(llm);
    for (const m of ["msg-055", "msg-022"]) {
      const id = await storeMessage(db, m);
      ids.push(id);
      await enqueue(h.queue, id);
    }
    for (const id of ids) await waitForCase(id);
    const log = logLines.join("\n");
    expect(log).toContain('"msg":"processed"');
    for (const m of ["msg-055", "msg-022"]) {
      const r = record(m);
      expect(log).not.toContain(r.text.slice(0, 30));
      for (const i of (r.final ?? r.chosen).fields.identifiers) expect(log).not.toContain(i.value);
    }
    expect(log).not.toContain("Customer writes about their service.");
  });
});
