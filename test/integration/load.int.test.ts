// The dataset loader over real HTTP against the API with PostgreSQL, on a random port.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFile, seedReceivedAt } from "../../eval/dataset/load.js";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import { buildApp } from "../../src/api/app.js";
import { KyselyInteractionStore } from "../../src/db/interactions.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const KEY = "loader-key-0123456789abcdef0123456789";
let testDb: TestDatabase;
let app: FastifyInstance;
let apiUrl: string;
let file: string;

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
  app = buildApp({
    store: new KyselyInteractionStore(testDb.db),
    apiKey: KEY,
    checkDb: () => Promise.resolve(),
    enqueue: () => Promise.resolve("queued"),
  });
  apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  // Three real dataset records, one per channel where possible.
  const records = readJsonl<{ channel: string }>(PATHS.dataset);
  const picked = ["email", "chat", "call"].map((c) => records.find((r) => r.channel === c)!);
  file = join(mkdtempSync(join(tmpdir(), "load-int-")), "three.jsonl");
  writeFileSync(file, picked.map((r) => JSON.stringify(r)).join("\n") + "\n");
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

describe("dataset loader", () => {
  it("creates every record on the first run and finds them all on the second", async () => {
    const first = await loadFile({ file, apiUrl, apiKey: KEY, log: () => {} });
    expect(first).toEqual({ created: 3, existing: 0, failed: [] });

    const second = await loadFile({ file, apiUrl, apiKey: KEY, log: () => {} });
    expect(second).toEqual({ created: 0, existing: 3, failed: [] });

    const rows = await sql<{ external_id: string; channel: string }>`
      select external_id, channel from interactions order by channel`.execute(testDb.db);
    expect(rows.rows.map((r) => r.channel)).toEqual(["call", "chat", "email"]);
    expect(rows.rows.every((r) => /^msg-\d{3}$/.test(r.external_id))).toBe(true);
  });

  it("stores each message's fixed received_at from the CRM seed", async () => {
    const seed = seedReceivedAt();
    const rows = await testDb.db.selectFrom("interactions").select(["external_id", "received_at"]).execute();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.received_at.toISOString()).toBe(seed.get(r.external_id!));
  });

  it("reports a wrong key as a failure", async () => {
    const report = await loadFile({ file, apiUrl, apiKey: "wrong", log: () => {} });
    expect(report.failed[0]?.reason).toContain("HTTP 401");
  });
});
