// Intake API unit tests: fastify.inject with the in-memory store, no database, no network.

import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";
import { LOGGER_OPTIONS } from "../../src/api/server.js";
import { MemoryInteractionStore } from "../support/memory-interaction-store.js";

const KEY = "test-key-0123456789abcdef0123456789";
const NOW = new Date("2026-11-18T10:00:00.000Z");
const AUTH = { "x-api-key": KEY };

const valid = { external_id: "msg-001", channel: "chat", language: "cs", text: "Dobrý den, nejde mi internet." };

let app: FastifyInstance;
let store: MemoryInteractionStore;
/** Interaction IDs passed to enqueue, in order. */
let enqueued: string[];

function setup(
  options: {
    checkDb?: () => Promise<void>;
    logStream?: Writable;
    enqueue?: (id: string) => Promise<"queued" | "failed">;
  } = {},
): FastifyInstance {
  store = new MemoryInteractionStore(() => NOW);
  enqueued = [];
  app = buildApp({
    store,
    apiKey: KEY,
    checkDb: options.checkDb ?? (() => Promise.resolve()),
    enqueue: (id) => {
      enqueued.push(id);
      return options.enqueue ? options.enqueue(id) : Promise.resolve("queued");
    },
    logger: options.logStream ? { ...LOGGER_OPTIONS, level: "trace", stream: options.logStream } : false,
  });
  return app;
}

function post(payload: unknown, headers: Record<string, string> = AUTH) {
  return app.inject({ method: "POST", url: "/interactions", headers, payload: payload as object });
}

afterEach(async () => {
  await app?.close();
});

describe("POST /interactions", () => {
  it("stores a valid interaction: 201, Location and the stored record", async () => {
    setup();
    const res = await post(valid);
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(res.headers.location).toBe(`/interactions/${String(body.id)}`);
    expect(body).toEqual({
      id: expect.any(String) as string,
      external_id: "msg-001",
      channel: "chat",
      language: "cs",
      text: valid.text,
      received_at: NOW.toISOString(),
      status: "received",
      created_at: NOW.toISOString(),
    });
    expect(store.rows).toHaveLength(1);
  });

  it("keeps the text exactly as sent, including whitespace and line breaks", async () => {
    setup();
    const text = "  Operátor: Dobrý den\r\nZákazník: Ahoj 👋  \n";
    const res = await post({ channel: "call", text });
    expect(res.json<{ text: string }>().text).toBe(text);
    expect(store.rows[0]?.text).toBe(text);
  });

  it("stores language and external_id as null when absent; language may be sent as null", async () => {
    setup();
    expect((await post({ channel: "email", text: "Hello" })).json()).toMatchObject({
      external_id: null,
      language: null,
    });
    expect((await post({ channel: "email", text: "Hello", language: null })).statusCode).toBe(201);
  });

  it("keeps a given received_at", async () => {
    setup();
    const res = await post({ ...valid, received_at: "2026-11-17T08:30:00+01:00" });
    expect(res.json<{ received_at: string }>().received_at).toBe("2026-11-17T07:30:00.000Z");
  });

  it("returns 200 and the same record for a repeat with the same content", async () => {
    setup();
    const first = (await post(valid)).json<{ id: string }>();
    const again = await post(valid);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ id: string }>().id).toBe(first.id);
    expect(store.rows).toHaveLength(1);
  });

  it("returns 409 for a repeat with different content, and changes nothing", async () => {
    setup();
    await post(valid);
    const res = await post({ ...valid, text: "Jiný text" });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toContain('"msg-001"');
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.text).toBe(valid.text);
  });

  it.each([
    ["missing channel", { text: "x" }, "channel"],
    ["missing text", { channel: "chat" }, "text"],
    ["unknown channel", { channel: "fax", text: "x" }, "channel"],
    ["unknown language", { channel: "chat", language: "de", text: "x" }, "language"],
    ["whitespace-only text", { channel: "chat", text: " \n\t " }, "text"],
    ["empty text", { channel: "chat", text: "" }, "text"],
    ["text over 20,000 characters", { channel: "chat", text: "a".repeat(20_001) }, "text"],
    ["an unknown field", { channel: "chat", text: "x", intent: "complaint" }, "intent"],
    [
      "received_at without a time zone",
      { channel: "chat", text: "x", received_at: "2026-11-17T08:30:00" },
      "received_at",
    ],
    ["a number as text (no type coercion)", { channel: "chat", text: 123 }, "text"],
    ["an empty external_id", { channel: "chat", text: "x", external_id: "" }, "external_id"],
    ["an external_id over 100 characters", { channel: "chat", text: "x", external_id: "e".repeat(101) }, "external_id"],
  ])("rejects %s with 400 naming the field", async (_case, payload, field) => {
    setup();
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toContain(field);
    expect(store.rows).toHaveLength(0);
  });

  it("accepts exactly 20,000 characters, counted as characters, not bytes", async () => {
    setup();
    expect((await post({ channel: "chat", text: "ž".repeat(20_000) })).statusCode).toBe(201);
  });

  it("rejects a body over 256 KB with 413", async () => {
    setup();
    const res = await post({ channel: "chat", text: "a".repeat(300 * 1024) });
    expect(res.statusCode).toBe(413);
  });
});

describe("API key", () => {
  it.each([
    ["no key", {}],
    ["a wrong key", { "x-api-key": "wrong" }],
    ["a key that is one character off", { "x-api-key": KEY.slice(0, -1) + "x" }],
  ])("answers 401 to %s, before validating the body, with the same message", async (_case, headers) => {
    setup();
    const res = await post({ nonsense: true }, headers);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ statusCode: 401, error: "Unauthorized", message: "Missing or invalid API key." });
  });

  it.each(["/interactions", "/interactions/00000000-0000-7000-8000-000000000001"])("protects GET %s", async (url) => {
    setup();
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
  });
});

describe("GET /interactions/:id", () => {
  it("returns a stored interaction", async () => {
    setup();
    const created = (await post(valid)).json<{ id: string }>();
    const res = await app.inject({ method: "GET", url: `/interactions/${created.id}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(created);
  });

  it("returns 404 for an unknown id", async () => {
    setup();
    const res = await app.inject({
      method: "GET",
      url: "/interactions/00000000-0000-7000-8000-0000000000ff",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for a malformed id", async () => {
    setup();
    const res = await app.inject({ method: "GET", url: "/interactions/msg-001", headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toContain("params/id");
  });
});

describe("GET /interactions", () => {
  async function list(query: string) {
    const res = await app.inject({ method: "GET", url: `/interactions${query}`, headers: AUTH });
    return {
      status: res.statusCode,
      body: res.json<{ items: { text: string; id: string }[]; next_before: string | null }>(),
    };
  }

  it("pages newest first: 25 rows in pages of 10, 10 and 5", async () => {
    setup();
    for (let i = 1; i <= 25; i++) await post({ channel: "chat", text: `message ${i}` });

    const p1 = await list("?limit=10");
    expect(p1.body.items.map((i) => i.text)).toEqual(Array.from({ length: 10 }, (_, k) => `message ${25 - k}`));
    const p2 = await list(`?limit=10&before=${p1.body.next_before}`);
    expect(p2.body.items[0]?.text).toBe("message 15");
    const p3 = await list(`?limit=10&before=${p2.body.next_before}`);
    expect(p3.body.items.map((i) => i.text)).toEqual(["message 5", "message 4", "message 3", "message 2", "message 1"]);
    expect(p3.body.next_before).toBeNull();
  });

  it("uses a page size of 20 by default", async () => {
    setup();
    for (let i = 1; i <= 21; i++) await post({ channel: "chat", text: `m${i}` });
    expect((await list("")).body.items).toHaveLength(20);
  });

  it.each(["?limit=0", "?limit=101", "?limit=abc", "?before=nope", "?other=1"])("rejects %s with 400", async (q) => {
    setup();
    expect((await list(q)).status).toBe(400);
  });
});

describe("GET /health", () => {
  it("answers 200 without a key when the database is reachable", async () => {
    setup();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("answers 503 when the database is not reachable", async () => {
    setup({ checkDb: () => Promise.reject(new Error("connection refused")) });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable" });
  });
});

describe("enqueueing (P08)", () => {
  it("enqueues each stored interaction once, and a repeat again; a conflict is not enqueued", async () => {
    setup();
    const first = (await post(valid)).json<{ id: string }>();
    expect(enqueued).toEqual([first.id]);
    expect((await post(valid)).statusCode).toBe(200);
    expect(enqueued).toEqual([first.id, first.id]);
    expect((await post({ ...valid, text: "different" })).statusCode).toBe(409);
    expect(enqueued).toHaveLength(2);
  });

  it("still answers 201 when enqueueing fails, and logs the ID only", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    setup({ enqueue: () => Promise.resolve("failed"), logStream: stream });
    const res = await post(valid);
    expect(res.statusCode).toBe(201);
    const log = lines.join("");
    expect(log).toContain("enqueue failed");
    expect(log).toContain(res.json<{ id: string }>().id);
    expect(log).not.toContain(valid.text);
  });

  it("does not enqueue rejected requests", async () => {
    setup();
    await post({ channel: "fax", text: "x" });
    await post(valid, {});
    expect(enqueued).toEqual([]);
  });
});

describe("errors and logging", () => {
  it("hides the text of a server error from the caller", async () => {
    setup();
    store.create = () => Promise.reject(new Error('relation "interactions" does not exist'));
    const res = await post(valid);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("relation");
  });

  it("never logs the message text or the API key", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    setup({ logStream: stream });
    await post(valid);
    await post({ ...valid, text: "Jiný text" }); // 409
    await post({ channel: "chat", text: 5 }); // 400
    await post(valid, { "x-api-key": "wrong-key-that-should-not-appear" }); // 401
    const log = lines.join("");
    expect(log).toContain("incoming request"); // the stream did capture request logs
    for (const secret of [valid.text, "Jiný text", KEY, "wrong-key-that-should-not-appear"]) {
      expect(log).not.toContain(secret);
    }
  });
});
