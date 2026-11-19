// The intake API against PostgreSQL (KyselyInteractionStore) on a throwaway database.

import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";
import { KyselyInteractionStore } from "../../src/db/interactions.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const KEY = "integration-key-0123456789abcdef0123";
const AUTH = { "x-api-key": KEY };

let testDb: TestDatabase;
let app: FastifyInstance;

async function rowCount(): Promise<number> {
  const r = await sql<{ n: string }>`select count(*) as n from interactions`.execute(testDb.db);
  return Number(r.rows[0]?.n);
}

function post(payload: object) {
  return app.inject({ method: "POST", url: "/interactions", headers: AUTH, payload });
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
  app = buildApp({
    store: new KyselyInteractionStore(testDb.db),
    apiKey: KEY,
    checkDb: async () => {
      await sql`select 1`.execute(testDb.db);
    },
    // The queue itself is tested in queue.int.test.ts.
    enqueue: () => Promise.resolve("queued"),
  });
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

describe("intake API with PostgreSQL", () => {
  const msg = { external_id: "msg-001", channel: "email", language: "sk", text: "Dobrý deň,\r\nnefunguje mi TV. 📺" };

  it("stores an interaction with a uuidv7 id, the exact text and status received", async () => {
    const res = await post({ ...msg, received_at: "2026-11-17T08:30:00+01:00" });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; text: string; status: string; received_at: string }>();
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(body).toMatchObject({ text: msg.text, status: "received", received_at: "2026-11-17T07:30:00.000Z" });

    const row = await testDb.db
      .selectFrom("interactions")
      .selectAll()
      .where("id", "=", body.id)
      .executeTakeFirstOrThrow();
    expect(row.raw_text).toBe(msg.text);
    expect(row.language).toBe("sk");
  });

  it("defaults received_at to the intake time", async () => {
    const before = Date.now();
    const res = await post({ channel: "chat", text: "no time given" });
    const receivedAt = Date.parse(res.json<{ received_at: string }>().received_at);
    expect(receivedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(receivedAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("answers a repeat with 200 and the same id, without a new row", async () => {
    const count = await rowCount();
    const first = await app.inject({ method: "GET", url: "/interactions?limit=100", headers: AUTH });
    const original = first
      .json<{ items: { id: string; external_id: string | null }[] }>()
      .items.find((i) => i.external_id === "msg-001");
    const res = await post(msg);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ id: string }>().id).toBe(original?.id);
    expect(await rowCount()).toBe(count);
  });

  it("answers a conflicting repeat with 409 and leaves the row unchanged", async () => {
    const res = await post({ ...msg, text: "something else" });
    expect(res.statusCode).toBe(409);
    const row = await testDb.db
      .selectFrom("interactions")
      .select("raw_text")
      .where("external_id", "=", "msg-001")
      .executeTakeFirstOrThrow();
    expect(row.raw_text).toBe(msg.text);
  });

  it("handles the same external_id sent ten times at once: one row, one 201", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => post({ external_id: "race-1", channel: "chat", text: "parallel" })),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    const r = await sql<{ n: string }>`select count(*) as n from interactions where external_id = 'race-1'`.execute(
      testDb.db,
    );
    expect(Number(r.rows[0]?.n)).toBe(1);
  });

  it("gets one interaction by id and answers 404 for an unknown one", async () => {
    const created = (await post({ channel: "call", text: "get me" })).json<{ id: string }>();
    const res = await app.inject({ method: "GET", url: `/interactions/${created.id}`, headers: AUTH });
    expect(res.json()).toEqual(created);
    const missing = await app.inject({
      method: "GET",
      url: "/interactions/00000000-0000-7000-8000-000000000000",
      headers: AUTH,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("pages over 25 new rows newest first in pages of 10, 10 and 5", async () => {
    await sql`truncate interactions cascade`.execute(testDb.db); // cascade: classifications reference interactions (P03)
    for (let i = 1; i <= 25; i++) await post({ channel: "chat", text: `page test ${i}` });

    const texts: string[][] = [];
    let before: string | null = null;
    do {
      const query: string = `/interactions?limit=10${before ? `&before=${before}` : ""}`;
      const page = (await app.inject({ method: "GET", url: query, headers: AUTH })).json<{
        items: { text: string }[];
        next_before: string | null;
      }>();
      texts.push(page.items.map((i) => i.text));
      before = page.next_before;
    } while (before);

    expect(texts.map((t) => t.length)).toEqual([10, 10, 5]);
    expect(texts.flat()).toEqual(Array.from({ length: 25 }, (_, k) => `page test ${25 - k}`));
  });

  it("reports health from the database", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});
