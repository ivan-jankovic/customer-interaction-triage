// The review web page (P13) against PostgreSQL, through fastify.inject. Cases are made by the
// pipeline runner with a scripted model client: no model calls.

import { Writable } from "node:stream";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";
import { LOGGER_OPTIONS } from "../../src/api/server.js";
import { seedCrm } from "../../src/db/crm.js";
import type { Database } from "../../src/db/database.js";
import { processInteraction } from "../../src/pipeline/process.js";
import { confirmCase } from "../../src/review/actions.js";
import { SECURITY_HEADERS } from "../../src/review/web/routes.js";
import { SESSION_TTL_MS } from "../../src/review/web/session.js";
import { MemoryInteractionStore } from "../support/memory-interaction-store.js";
import {
  byMaskedText,
  labelsOf,
  processDeps,
  record,
  scriptedLlm,
  seed,
  storeMessage,
  type Answer,
} from "../support/pipeline.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const INTAKE_KEY = "intake-key-0123456789abcdef0123456789";
const REVIEW_KEY = "review-key-0123456789abcdef0123456789";

let testDb: TestDatabase;
let db: Kysely<Database>;
let app: FastifyInstance;
let clock = new Date();
const logLines: string[] = [];

function makeApp(review = true, logs = false): FastifyInstance {
  return buildApp({
    store: new MemoryInteractionStore(),
    apiKey: INTAKE_KEY,
    checkDb: () => Promise.resolve(),
    enqueue: () => Promise.resolve("queued"),
    ...(review ? { review: { db, reviewKey: REVIEW_KEY, now: () => clock } } : {}),
    logger: logs
      ? {
          ...LOGGER_OPTIONS,
          level: "trace",
          stream: new Writable({
            write(chunk: Buffer, _enc, cb) {
              logLines.push(chunk.toString());
              cb();
            },
          }),
        }
      : false,
  });
}

/** Stores a dataset message and processes it; returns the case ID. */
async function makeCase(messageId: string, answer: Answer = "valid"): Promise<string> {
  const id = await storeMessage(db, messageId);
  const r = await processInteraction(db, processDeps(scriptedLlm([answer], byMaskedText([messageId]))), id, {
    finalAttempt: true,
  });
  return r.case.id;
}

async function clearCases() {
  await sql`truncate reviews, unmask_log`.execute(db);
  await sql`delete from decision_log`.execute(db);
  await sql`delete from cases`.execute(db);
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** The cookie pair ("name=value") a response set, or null when it cleared or set none. */
function sessionCookie(res: LightMyRequestResponse): string | null {
  const header = res.headers["set-cookie"];
  const all = Array.isArray(header) ? header : header ? [header] : [];
  const c = all.find((h) => h.startsWith("review_session="));
  if (!c) return null;
  const pair = c.split(";")[0]!;
  return pair === "review_session=" ? null : pair;
}

interface Login {
  cookie: string;
  csrf: string;
}

async function login(reviewer = "reviewer-1", target = app): Promise<Login> {
  const res = await target.inject({
    method: "POST",
    url: "/review/login",
    headers: FORM,
    payload: form({ key: REVIEW_KEY, reviewer }),
  });
  expect(res.statusCode).toBe(303);
  const cookie = sessionCookie(res)!;
  const page = await target.inject({ method: "GET", url: "/review", headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
  return { cookie, csrf };
}

const get = (s: Login | null, url: string) =>
  app.inject({ method: "GET", url, headers: s ? { cookie: s.cookie } : {} });

const post = (s: Login | null, url: string, fields: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url,
    headers: { ...FORM, ...(s ? { cookie: s.cookie } : {}) },
    payload: form({ ...(s ? { csrf: s.csrf } : {}), ...fields }),
  });

async function reviewCount(caseId: string): Promise<number> {
  const r = await sql<{ n: string }>`select count(*) as n from reviews where case_id = ${caseId}`.execute(db);
  return Number(r.rows[0]!.n);
}

function identifierValues(messageId: string): string[] {
  return labelsOf(messageId).fields.identifiers.map((i) => i.value);
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
  db = testDb.db;
  await seedCrm(db, seed);
  app = makeApp();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

beforeEach(() => {
  clock = new Date();
});

describe("without REVIEW_API_KEY", () => {
  it("serves no /review routes, and intake works as before", async () => {
    const plain = makeApp(false);
    try {
      expect((await plain.inject({ method: "GET", url: "/review" })).statusCode).toBe(404);
      expect((await plain.inject({ method: "GET", url: "/review/login" })).statusCode).toBe(404);
      const res = await plain.inject({
        method: "POST",
        url: "/interactions",
        headers: { "x-api-key": INTAKE_KEY },
        payload: { channel: "chat", text: "Dobrý den" },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await plain.close();
    }
  });
});

describe("access and sessions", () => {
  it("shows the login form", async () => {
    const res = await get(null, "/review/login");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toContain('name="key"');
  });

  it("refuses a wrong key (401) and a bad handle (400) without setting a cookie", async () => {
    const wrongKey = await post(null, "/review/login", { key: "x".repeat(40), reviewer: "reviewer-1" });
    expect(wrongKey.statusCode).toBe(401);
    expect(wrongKey.body).toContain("Wrong review key.");
    expect(sessionCookie(wrongKey)).toBeNull();
    const badHandle = await post(null, "/review/login", { key: REVIEW_KEY, reviewer: "Jan Novák" });
    expect(badHandle.statusCode).toBe(400);
    expect(badHandle.body).toContain("is not a reviewer handle");
    expect(sessionCookie(badHandle)).toBeNull();
    // The intake key is not the review key.
    expect((await post(null, "/review/login", { key: INTAKE_KEY, reviewer: "reviewer-1" })).statusCode).toBe(401);
  });

  it("sets a signed, HttpOnly, SameSite=Strict cookie on /review and redirects to the queue", async () => {
    const res = await post(null, "/review/login", { key: REVIEW_KEY, reviewer: "reviewer-1" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/review");
    const header = String(res.headers["set-cookie"]);
    expect(header).toMatch(/^review_session=[^;]+\.[^;]+;/); // value.signature
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/review");
    expect(header).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(header).not.toContain("Secure"); // plain HTTP in tests; "auto" sets it over HTTPS
  });

  it("redirects a GET without a session to the login page and refuses a POST with 401", async () => {
    const caseId = await makeCase("msg-013");
    const page = await get(null, "/review");
    expect(page.statusCode).toBe(303);
    expect(page.headers.location).toBe("/review/login");
    const res = await post(null, `/review/cases/${caseId}/confirm`, { csrf: "x" });
    expect(res.statusCode).toBe(401);
    expect(await reviewCount(caseId)).toBe(0);
  });

  it("treats a tampered, expired or other-key cookie as no session", async () => {
    const s = await login();
    const [name, value] = s.cookie.split("=") as [string, string];
    const decoded = decodeURIComponent(value);
    const dot = decoded.lastIndexOf(".");
    const payload = JSON.parse(Buffer.from(decoded.slice(0, dot), "base64url").toString()) as { reviewer: string };
    payload.reviewer = "reviewer-9";
    const forged = `${name}=${encodeURIComponent(
      Buffer.from(JSON.stringify(payload)).toString("base64url") + decoded.slice(dot),
    )}`;
    expect((await get({ ...s, cookie: forged }, "/review")).statusCode).toBe(303);

    clock = new Date(clock.getTime() + SESSION_TTL_MS + 1000);
    expect((await get(s, "/review")).statusCode).toBe(303);
    clock = new Date();

    const other = buildApp({
      store: new MemoryInteractionStore(),
      apiKey: INTAKE_KEY,
      checkDb: () => Promise.resolve(),
      enqueue: () => Promise.resolve("queued"),
      review: { db, reviewKey: "another-review-key-0123456789abcdef" },
    });
    try {
      expect((await other.inject({ method: "GET", url: "/review", headers: { cookie: s.cookie } })).statusCode).toBe(
        303,
      );
    } finally {
      await other.close();
    }
  });

  it("refuses a POST with a missing or wrong CSRF token (403) and stores nothing", async () => {
    const caseId = await makeCase("msg-013");
    const s = await login();
    const missing = await app.inject({
      method: "POST",
      url: `/review/cases/${caseId}/confirm`,
      headers: { ...FORM, cookie: s.cookie },
      payload: form({ note: "ok" }),
    });
    expect(missing.statusCode).toBe(403);
    const other = await login("reviewer-2");
    const wrong = await post({ ...s, csrf: other.csrf }, `/review/cases/${caseId}/confirm`);
    expect(wrong.statusCode).toBe(403);
    expect(await reviewCount(caseId)).toBe(0);
  });

  it("logs out by clearing the cookie", async () => {
    const s = await login();
    const res = await post(s, "/review/logout");
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/review/login");
    expect(String(res.headers["set-cookie"])).toMatch(/^review_session=;.*Expires=Thu, 01 Jan 1970/);
  });

  it("redirects a logged-in reviewer from the login page to the queue", async () => {
    const s = await login();
    expect((await get(s, "/review/login")).headers.location).toBe("/review");
  });
});

describe("queue and next", () => {
  let cases: Record<string, string>;
  let s: Login;
  beforeAll(async () => {
    await clearCases();
    cases = {
      auto: await makeCase("msg-011"), // technical fault, found, auto-routed
      cancellation: await makeCase("msg-013"),
      ambiguous: await makeCase("msg-022"),
      unidentified: await makeCase("msg-007"),
    };
    s = await login();
  });

  it("lists pending cases oldest first, with the count", async () => {
    const res = await get(s, "/review");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<strong>3</strong> cases waiting for review.");
    const order = [cases.cancellation, cases.ambiguous, cases.unidentified].map((id) => res.body.indexOf(id!));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(res.body).not.toContain(cases.auto);
  });

  it("filters by spot check, team and reason", async () => {
    const spot = await get(s, "/review?spot_check=1");
    expect(spot.body).toContain("<strong>1</strong> auto-routed cases");
    expect(spot.body).toContain(cases.auto);
    const team = await get(s, "/review?team=technical_support&reason=&spot_check=");
    expect(team.body).toContain("<strong>1</strong> cases");
    expect(team.body).toContain(cases.unidentified);
    const reason = await get(s, "/review?reason=customer_ambiguous");
    expect(reason.body).toContain(cases.ambiguous);
    expect(reason.body).not.toContain(cases.cancellation);
  });

  it("refuses unknown filter values with 400", async () => {
    for (const q of ["team=legal", "reason=nope", "spot_check=yes", "after=1", "extra=1"]) {
      const res = await get(s, `/review?${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    }
  });

  it("redirects next to the oldest case, keeping the filters", async () => {
    expect((await get(s, "/review/next")).headers.location).toBe(`/review/cases/${cases.cancellation}`);
    expect((await get(s, "/review/next?spot_check=1")).headers.location).toBe(
      `/review/cases/${cases.auto}?spot_check=1`,
    );
  });

  it("says when the queue is empty", async () => {
    const res = await get(s, "/review/next?reason=complaint");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No cases to review");
  });

  it("skips a case for the session only: next moves on, the queue marks it, a new login brings it back", async () => {
    const res = await post(s, `/review/cases/${cases.cancellation}/skip`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/review/next?done=skipped");
    const skipped = { ...s, cookie: sessionCookie(res)! };
    const next = await get(skipped, "/review/next?done=skipped");
    expect(next.headers.location).toBe(`/review/cases/${cases.ambiguous}?done=skipped`);
    const casePage = await get(skipped, next.headers.location!);
    expect(casePage.body).toContain("Case skipped.");
    expect((await get(skipped, "/review")).body).toContain('<span class="tag">skipped</span>');
    expect(await reviewCount(cases.cancellation!)).toBe(0);

    const fresh = await login();
    expect((await get(fresh, "/review/next")).headers.location).toBe(`/review/cases/${cases.cancellation}`);
  });
});

describe("case page", () => {
  let s: Login;
  beforeAll(async () => {
    await clearCases();
    s = await login();
  });

  it("shows the sections, with the position, masked text and investigation, and no identifier or raw text", async () => {
    await makeCase("msg-013");
    const caseId = await makeCase("msg-011");
    const res = await get(s, `/review/cases/${caseId}?spot_check=1`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Case 1 of 1");
    for (const heading of [
      "Decision",
      "Classification",
      "Message (masked)",
      "Evidence",
      "Investigation",
      "Decision log",
    ]) {
      expect(res.body).toContain(`<h2>${heading}</h2>`);
    }
    expect(res.body).toContain("Likely cause <strong>area_outage</strong>");
    expect(res.body).toContain("<code>check_outages</code>");
    expect(res.body).toContain("Customer lookup: <strong>found</strong>");
    for (const v of identifierValues("msg-011")) expect(res.body).not.toContain(v);
    expect(res.body).not.toContain("Raw text");
    expect(res.body).toContain("/confirm");
  });

  it("shows ambiguous candidates and unmatched placeholders, without identifier values", async () => {
    const ambiguous = await get(s, `/review/cases/${await makeCase("msg-022")}`);
    expect(ambiguous.body).toContain("Candidates:");
    for (const v of identifierValues("msg-022")) expect(ambiguous.body).not.toContain(v);
    const notFound = await get(s, `/review/cases/${await makeCase("msg-001")}`);
    expect(notFound.body).toContain("Not in the CRM:");
    for (const v of identifierValues("msg-001")) expect(notFound.body).not.toContain(v);
  });

  it("shows a processing_failed case without masked text or classification", async () => {
    const id = await storeMessage(db, "msg-011");
    await sql`alter table interactions add constraint t_fail check (masked_text is null) not valid`.execute(db);
    let caseId: string;
    try {
      const r = await processInteraction(db, processDeps(scriptedLlm(["valid"], byMaskedText(["msg-011"]))), id, {
        finalAttempt: true,
      });
      caseId = r.case.id;
    } finally {
      await sql`alter table interactions drop constraint t_fail`.execute(db);
    }
    const res = await get(s, `/review/cases/${caseId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<code>processing_failed</code>");
    expect(res.body).toContain("None: processing failed before classifying.");
    expect(res.body).toContain("Not masked: processing failed at masking.");
  });

  it("shows a reviewed case's review and no forms", async () => {
    const caseId = await makeCase("msg-013");
    await confirmCase(db, caseId, { reviewer: "reviewer-2", note: "fine" });
    const res = await get(s, `/review/cases/${caseId}`);
    expect(res.body).toContain("<dt>Reviewer</dt><dd>reviewer-2</dd>");
    expect(res.body).not.toContain(`/cases/${caseId}/confirm`);
    expect(res.body).not.toContain("Case 1 of");
  });

  it("answers 404 for an unknown case and 400 for a malformed ID", async () => {
    expect((await get(s, "/review/cases/0190e9a0-0000-7000-8000-000000000000")).statusCode).toBe(404);
    expect((await get(s, "/review/cases/not-a-uuid")).statusCode).toBe(400);
  });
});

describe("actions", () => {
  let s: Login;
  beforeAll(async () => {
    await clearCases();
    s = await login();
  });

  async function storedReview(caseId: string) {
    return db.selectFrom("reviews").selectAll().where("case_id", "=", caseId).executeTakeFirst();
  }

  it("confirms with the session's reviewer and redirects to the next case, keeping the filters", async () => {
    const caseId = await makeCase("msg-013");
    const res = await post(s, `/review/cases/${caseId}/confirm`, { note: " looks right ", reason: "cancellation" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/review/next?reason=cancellation&done=confirmed");
    expect(await storedReview(caseId)).toMatchObject({
      reviewer: "reviewer-1",
      decision: "confirmed",
      note: "looks right",
      spot_check: false,
    });
  });

  it("corrects with the intent's team, or with a picked team, and records a spot check", async () => {
    const pending = await makeCase("msg-013"); // cancellation → retention
    const r1 = await post(s, `/review/cases/${pending}/correct`, {
      intent: "complaint",
      new_team: "auto",
      note: "angry",
    });
    expect(r1.statusCode).toBe(303);
    expect(await storedReview(pending)).toMatchObject({
      decision: "corrected",
      corrected_intent: "complaint",
      corrected_team: "complaints",
      note: "angry",
    });

    const auto = await makeCase("msg-011");
    const r2 = await post(s, `/review/cases/${auto}/correct`, {
      intent: labelsOf("msg-011").intent,
      new_team: "general",
      note: "team override",
      spot_check: "1",
    });
    expect(r2.headers.location).toBe("/review/next?spot_check=1&done=corrected");
    expect(await storedReview(auto)).toMatchObject({ corrected_team: "general", spot_check: true });
  });

  it("refuses a correction without a note, without an intent, or changing nothing (400), keeping the input", async () => {
    const caseId = await makeCase("msg-013");
    const noNote = await post(s, `/review/cases/${caseId}/correct`, {
      intent: "complaint",
      new_team: "auto",
      note: " ",
    });
    expect(noNote.statusCode).toBe(400);
    expect(noNote.body).toContain("A correction needs a note saying why.");
    expect(noNote.body).toContain('<option value="complaint" selected>');
    const noIntent = await post(s, `/review/cases/${caseId}/correct`, { intent: "", new_team: "auto", note: "n" });
    expect(noIntent.statusCode).toBe(400);
    expect(noIntent.body).toContain("Pick the intent the case should have.");
    const same = await post(s, `/review/cases/${caseId}/correct`, {
      intent: "cancellation",
      new_team: "auto",
      note: "n",
    });
    expect(same.statusCode).toBe(400);
    expect(same.body).toContain("confirm the case instead");
    const badTeam = await post(s, `/review/cases/${caseId}/correct`, {
      intent: "complaint",
      new_team: "legal",
      note: "n",
    });
    expect(badTeam.statusCode).toBe(400);
    expect(await reviewCount(caseId)).toBe(0);
  });

  it("refuses a second review with 409 and the first reviewer, one after the other or concurrently", async () => {
    const caseId = await makeCase("msg-013");
    await post(s, `/review/cases/${caseId}/confirm`);
    const other = await login("reviewer-2");
    const second = await post(other, `/review/cases/${caseId}/correct`, {
      intent: "complaint",
      new_team: "auto",
      note: "n",
    });
    expect(second.statusCode).toBe(409);
    expect(second.body).toContain("Already reviewed by reviewer-1 at");
    expect(second.body).toContain("<dt>Decision</dt><dd>confirmed</dd>");

    const raced = await makeCase("msg-013");
    const results = await Promise.all([
      post(s, `/review/cases/${raced}/confirm`),
      post(other, `/review/cases/${raced}/confirm`),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([303, 409]);
    expect(await reviewCount(raced)).toBe(1);
  });

  it("answers 404 for an action on an unknown case", async () => {
    expect((await post(s, "/review/cases/0190e9a0-0000-7000-8000-000000000000/confirm")).statusCode).toBe(404);
  });

  it("unmasks with a logged reason, shows the raw text once, and the next view is masked again", async () => {
    const caseId = await makeCase("msg-001");
    const short = await post(s, `/review/cases/${caseId}/unmask`, { unmask_reason: "x" });
    expect(short.statusCode).toBe(400);
    const none = await sql<{ n: string }>`select count(*) as n from unmask_log where case_id = ${caseId}`.execute(db);
    expect(Number(none.rows[0]!.n)).toBe(0);

    const res = await post(s, `/review/cases/${caseId}/unmask`, { unmask_reason: "search the CRM by phone" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Raw text, unmask logged at");
    const raw = record("msg-001").text;
    const firstLine = raw.split("\n")[0]!;
    expect(res.body).toContain(
      firstLine
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;"),
    );
    const logged = await db.selectFrom("unmask_log").selectAll().where("case_id", "=", caseId).execute();
    expect(logged).toMatchObject([{ reviewer: "reviewer-1", reason: "search the CRM by phone" }]);

    // With the reason filter set, the form posts both fields (P13: names must not collide).
    const filtered = await post(s, `/review/cases/${caseId}/unmask`, {
      reason: "customer_not_found",
      unmask_reason: "second look with the filter on",
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.body).toContain("Raw text, unmask logged at");

    const again = await get(s, `/review/cases/${caseId}`);
    expect(again.body).not.toContain("Raw text");
    for (const v of identifierValues("msg-001")) expect(again.body).not.toContain(v);
    expect(again.body).toContain("reviewer-1 at");
    expect(again.body).toContain("search the CRM by phone");
  });
});

describe("reviewed list", () => {
  let s: Login;
  let confirmed: string;
  let corrected: string;
  beforeAll(async () => {
    await clearCases();
    s = await login();
    confirmed = await makeCase("msg-013");
    corrected = await makeCase("msg-013");
    await post(s, `/review/cases/${confirmed}/confirm`);
    const other = await login("reviewer-2");
    await post(other, `/review/cases/${corrected}/correct`, { intent: "complaint", new_team: "auto", note: "angry" });
  });

  it("lists reviews newest first with the effective decision", async () => {
    const res = await get(s, "/review/reviewed");
    expect(res.statusCode).toBe(200);
    expect(res.body.indexOf(corrected)).toBeLessThan(res.body.indexOf(confirmed));
    expect(res.body).toContain('complaint → complaints<br><span class="muted">was cancellation → retention</span>');
    expect(res.body).toContain("cancellation → retention");
  });

  it("filters by reviewer and decision, and refuses bad values", async () => {
    const byReviewer = await get(s, "/review/reviewed?reviewer=reviewer-1&decision=");
    expect(byReviewer.body).toContain(confirmed);
    expect(byReviewer.body).not.toContain(corrected);
    const byDecision = await get(s, "/review/reviewed?decision=corrected");
    expect(byDecision.body).toContain(corrected);
    expect(byDecision.body).not.toContain(confirmed);
    expect((await get(s, "/review/reviewed?reviewer=Jan%20Nov%C3%A1k")).statusCode).toBe(400);
    expect((await get(s, "/review/reviewed?decision=maybe")).statusCode).toBe(400);
  });
});

describe("headers, escaping and logs", () => {
  it("sends the security headers on every /review response", async () => {
    await clearCases();
    const caseId = await makeCase("msg-013");
    const s = await login();
    const responses = [
      await get(null, "/review/login"),
      await get(null, "/review/style.css"),
      await get(null, "/review"),
      await get(s, "/review"),
      await get(s, `/review/cases/${caseId}`),
      await get(s, "/review/reviewed"),
      await get(s, "/review?team=legal"),
      await post(null, `/review/cases/${caseId}/confirm`),
      await post(s, `/review/cases/${caseId}/unmask`, { unmask_reason: "check the phone" }),
    ];
    for (const res of responses) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers[name], name).toBe(value);
    }
    expect(SECURITY_HEADERS["content-security-policy"]).toContain("default-src 'none'");
    expect(SECURITY_HEADERS["content-security-policy"]).not.toContain("script-src");
    expect(responses[1]!.headers["content-type"]).toBe("text/css; charset=utf-8");
    for (const res of responses) {
      expect(res.body).not.toMatch(/<script/i);
      expect(res.body).not.toMatch(/\son[a-z]+=/i);
    }
  });

  it("escapes a message containing a script on the case page and after unmask", async () => {
    await clearCases();
    const evil = `<script>alert("x")</script> <img src=x onerror=alert(1)> volám z +420 777 123 456`;
    const id = await storeMessage(db, "msg-013", { text: `${record("msg-013").text}\n${evil}` });
    const r = await processInteraction(db, processDeps(scriptedLlm(["valid"], byMaskedText(["msg-013"]))), id, {
      finalAttempt: true,
    });
    const s = await login();
    const page = await get(s, `/review/cases/${r.case.id}`);
    expect(page.body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(page.body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(page.body).not.toContain("777 123 456");
    const unmasked = await post(s, `/review/cases/${r.case.id}/unmask`, { unmask_reason: "check the phone" });
    expect(unmasked.body).toContain("&lt;script&gt;");
    expect(unmasked.body).toContain("+420 777 123 456");
    expect(unmasked.body).not.toMatch(/<script|<img/i);
  });

  it("logs no cookie, form body or review key", async () => {
    await clearCases();
    const caseId = await makeCase("msg-013");
    const logged = makeApp(true, true);
    try {
      const s = await login("reviewer-1", logged);
      await logged.inject({
        method: "POST",
        url: `/review/cases/${caseId}/unmask`,
        headers: { ...FORM, cookie: s.cookie },
        payload: form({ csrf: s.csrf, unmask_reason: "secret-reason-text" }),
      });
      const text = logLines.join("");
      expect(text).toContain("/review/cases/");
      expect(text).not.toContain(REVIEW_KEY);
      expect(text).not.toContain(s.cookie.split("=")[1]!);
      expect(text).not.toContain("secret-reason-text");
      expect(text).not.toContain(s.csrf);
    } finally {
      await logged.close();
    }
  });
});
