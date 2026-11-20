// The review web page (P13 requirements.md, "Pages and routes"): a Fastify plugin registered by
// buildApp under /review when REVIEW_API_KEY is set. It calls the same review functions as the
// CLI (src/review/); only the HTML and the session are new.
//
// - Access: a login with the shared review key and a handle sets a signed session cookie. A GET
//   without a session redirects to the login page, a POST gets 401. Every POST must carry the
//   session's CSRF token, on top of SameSite=Strict.
// - The cookie and form plugins are registered inside this plugin's scope, so the intake API
//   neither parses forms nor reads cookies.
// - Every response gets a CSP that allows no script, and no-store, since the unmask response
//   holds raw personal data.

import formbody from "@fastify/formbody";
import cookie from "@fastify/cookie";
import type { JsonSchemaToTsProvider } from "@fastify/type-provider-json-schema-to-ts";
import type { FastifyError, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "../../db/database.js";
import { confirmCase, correctCase, InvalidReview, unmaskCase, type ReviewResult } from "../actions.js";
import { CaseNotFound, readCaseView } from "../case-view.js";
import { listQueue, nextCase, queuePosition, queueSize, type QueueFilters } from "../queue.js";
import { listReviewed } from "../reviewed.js";
import { defaultTeamFor, isIntent, isTeam, parseReviewer } from "../rules.js";
import { escapeHtml } from "./html.js";
import {
  INTENT_TEAM,
  STYLESHEET,
  casePage,
  emptyQueuePage,
  filterParams,
  loginPage,
  queuePage,
  reviewedPage,
  type FormError,
  type FormName,
  type Notice,
  type PageFilters,
  type RawText,
  type Viewer,
} from "./pages.js";
import {
  caseParams,
  caseQuery,
  confirmBody,
  correctBody,
  loginBody,
  logoutBody,
  nextQuery,
  queueQuery,
  reviewedQuery,
  skipBody,
  unmaskBody,
  type NoticeName,
} from "./schemas.js";
import {
  SESSION_COOKIE,
  addSkipped,
  cookieSecret,
  decodeSession,
  encodeSession,
  newSession,
  sameSecret,
  type Session,
} from "./session.js";

export interface ReviewRoutesOptions {
  db: Kysely<Database>;
  /** REVIEW_API_KEY: checked at login, and the cookie-signing secret is derived from it. */
  reviewKey: string;
  /** For tests: the clock used for session expiry. */
  now?: () => Date;
}

export const PAGE_SIZE = 50;

export const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

const NOTICE_TEXT: Record<NoticeName, string> = {
  confirmed: "Case confirmed.",
  corrected: "Case corrected.",
  skipped: "Case skipped. It comes back after you log in again.",
};

declare module "fastify" {
  interface FastifyRequest {
    /** The review session, set by the plugin's preValidation hook; null on public routes. */
    reviewSession: Session | null;
  }
  interface FastifyContextConfig {
    /** A /review route that needs no session (login, the stylesheet). */
    reviewPublic?: boolean;
  }
}

interface FilterInput {
  team?: string | undefined;
  reason?: string | undefined;
  spot_check?: string | undefined;
}

/** The schemas already restrict the values; "" means "any". */
function pageFilters(q: FilterInput): PageFilters {
  return {
    team: (q.team || undefined) as PageFilters["team"],
    reason: (q.reason || undefined) as PageFilters["reason"],
    spotCheck: q.spot_check === "1",
  };
}

const queueFilters = (f: PageFilters, exclude: readonly string[] = []): QueueFilters => ({
  spotCheck: f.spotCheck,
  team: f.team,
  reason: f.reason,
  exclude,
});

const viewerOf = (s: Session): Viewer => ({ reviewer: s.reviewer, csrf: s.csrf });

function sendPage(reply: FastifyReply, status: number, page: string) {
  return reply.code(status).type("text/html; charset=utf-8").send(page);
}

/** A bare page for errors outside a case (bad query, unknown case, ended session). */
function messagePage(title: string, text: string, link: { href: string; label: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Review</title><link rel="stylesheet" href="/review/style.css"></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p></main></body></html>
`;
}

export const reviewRoutes: FastifyPluginCallback<ReviewRoutesOptions> = (plugin, opts, done) => {
  const app = plugin.withTypeProvider<JsonSchemaToTsProvider>();
  const { db } = opts;
  const now = opts.now ?? (() => new Date());

  void app.register(formbody);
  void app.register(cookie, { secret: cookieSecret(opts.reviewKey), hook: "onRequest" });

  app.decorateRequest("reviewSession", null);

  app.addHook("onSend", async (_request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, "review request failed");
      return sendPage(
        reply,
        500,
        messagePage("Something went wrong", "Internal error.", { href: "/review", label: "Back to the queue" }),
      );
    }
    return sendPage(
      reply,
      status,
      messagePage("Bad request", error.message, { href: "/review", label: "Back to the queue" }),
    );
  });

  function readSession(request: FastifyRequest): Session | null {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const unsigned = request.unsignCookie(raw);
    return unsigned.valid && unsigned.value !== null ? decodeSession(unsigned.value, now()) : null;
  }

  function setSession(reply: FastifyReply, s: Session) {
    void reply.setCookie(SESSION_COOKIE, encodeSession(s), {
      signed: true,
      httpOnly: true,
      sameSite: "strict",
      path: "/review",
      secure: "auto",
      maxAge: Math.max(0, Math.floor((s.expiresAt - now().getTime()) / 1000)),
    });
  }

  // preValidation runs after the body is parsed and before it is validated, so a post without a
  // session or token is refused whatever its fields are.
  app.addHook("preValidation", async (request, reply) => {
    if (request.routeOptions.config.reviewPublic) return;
    const session = readSession(request);
    if (!session) {
      if (request.method === "GET") return reply.redirect("/review/login", 303);
      return sendPage(
        reply,
        401,
        messagePage("Session ended", "Your session has ended or you are not logged in. Nothing was stored.", {
          href: "/review/login",
          label: "Log in",
        }),
      );
    }
    if (request.method === "POST") {
      const given = (request.body as Record<string, unknown> | undefined)?.csrf;
      if (typeof given !== "string" || !sameSecret(given, session.csrf)) {
        return sendPage(
          reply,
          403,
          messagePage(
            "Form expired",
            "This form doesn't belong to your session. Nothing was stored. Reload the page and try again.",
            {
              href: "/review",
              label: "Back to the queue",
            },
          ),
        );
      }
    }
    request.reviewSession = session;
  });

  const session = (request: FastifyRequest) => request.reviewSession!;

  // ---- Public ----------------------------------------------------------------------------------

  app.get("/style.css", { config: { reviewPublic: true } }, async (_request, reply) =>
    reply.type("text/css; charset=utf-8").send(STYLESHEET),
  );

  app.get("/login", { config: { reviewPublic: true } }, async (request, reply) => {
    if (readSession(request)) return reply.redirect("/review", 303);
    return sendPage(reply, 200, loginPage());
  });

  app.post("/login", { config: { reviewPublic: true }, schema: { body: loginBody } }, async (request, reply) => {
    const { key, reviewer } = request.body;
    // The key is checked first, and its error never says more than "wrong".
    if (!sameSecret(key, opts.reviewKey)) {
      return sendPage(reply, 401, loginPage({ error: "Wrong review key.", reviewer }));
    }
    const handle = parseReviewer(reviewer);
    if (!handle.ok) {
      const error = reviewer.trim() ? handle.error : "Type your reviewer handle, e.g. reviewer-1.";
      return sendPage(reply, 400, loginPage({ error, reviewer }));
    }
    setSession(reply, newSession(handle.value, now()));
    return reply.redirect("/review", 303);
  });

  // ---- With a session --------------------------------------------------------------------------

  app.post("/logout", { schema: { body: logoutBody } }, async (_request, reply) => {
    void reply.clearCookie(SESSION_COOKIE, { path: "/review" });
    return reply.redirect("/review/login", 303);
  });

  app.get("/", { schema: { querystring: queueQuery } }, async (request, reply) => {
    const s = session(request);
    const f = pageFilters(request.query);
    const rows = await listQueue(db, queueFilters(f), { after: request.query.after, limit: PAGE_SIZE });
    const total = await queueSize(db, queueFilters(f));
    return sendPage(
      reply,
      200,
      queuePage({
        viewer: viewerOf(s),
        filters: f,
        total,
        rows,
        skipped: s.skipped,
        nextAfter: rows.length === PAGE_SIZE ? rows.at(-1)!.caseId : null,
      }),
    );
  });

  app.get("/next", { schema: { querystring: nextQuery } }, async (request, reply) => {
    const s = session(request);
    const f = pageFilters(request.query);
    const id = await nextCase(db, queueFilters(f, s.skipped));
    if (!id) {
      const done = request.query.done;
      const notice: Notice | undefined = done ? { kind: "info", text: NOTICE_TEXT[done] } : undefined;
      return sendPage(reply, 200, emptyQueuePage({ viewer: viewerOf(s), filters: f, notice }));
    }
    return reply.redirect(`/review/cases/${id}${filterParams(f, { done: request.query.done })}`, 303);
  });

  /** The case page, after a GET or a refused or special action. */
  async function renderCase(
    request: FastifyRequest,
    reply: FastifyReply,
    caseId: string,
    f: PageFilters,
    extra: { status?: number; error?: FormError; rawText?: RawText; notice?: Notice } = {},
  ) {
    const view = await readCaseView(db, caseId);
    const position = await queuePosition(db, queueFilters(f), caseId);
    return sendPage(
      reply,
      extra.status ?? 200,
      casePage({ viewer: viewerOf(session(request)), view, position, filters: f, ...extra }),
    );
  }

  function caseNotFound(reply: FastifyReply) {
    return sendPage(
      reply,
      404,
      messagePage("No such case", "There is no case with this ID.", { href: "/review", label: "Back to the queue" }),
    );
  }

  /** Runs an action; maps the review errors to the case page (400) or the not-found page (404). */
  async function act(
    request: FastifyRequest,
    reply: FastifyReply,
    caseId: string,
    f: PageFilters,
    form: FormName,
    values: Record<string, string>,
    run: () => Promise<FastifyReply>,
  ) {
    try {
      return await run();
    } catch (error) {
      if (error instanceof CaseNotFound) return caseNotFound(reply);
      if (error instanceof InvalidReview) {
        return renderCase(request, reply, caseId, f, { status: 400, error: { form, message: error.message, values } });
      }
      throw error;
    }
  }

  /** Stored → the next case; another reviewer was first → the case page with their review (409). */
  async function afterReview(
    request: FastifyRequest,
    reply: FastifyReply,
    caseId: string,
    f: PageFilters,
    result: ReviewResult,
    done: NoticeName,
  ) {
    if (result.stored) return reply.redirect(`/review/next${filterParams(f, { done })}`, 303);
    const r = result.existing;
    return renderCase(request, reply, caseId, f, {
      status: 409,
      notice: {
        kind: "error",
        text: `Already reviewed by ${r.reviewer} at ${r.reviewedAt.toISOString()}. Nothing was stored.`,
      },
    });
  }

  app.get("/cases/:id", { schema: { params: caseParams, querystring: caseQuery } }, async (request, reply) => {
    const f = pageFilters(request.query);
    const done = request.query.done;
    try {
      return await renderCase(request, reply, request.params.id, f, {
        ...(done ? { notice: { kind: "info", text: NOTICE_TEXT[done] } } : {}),
      });
    } catch (error) {
      if (error instanceof CaseNotFound) return caseNotFound(reply);
      throw error;
    }
  });

  app.post("/cases/:id/confirm", { schema: { params: caseParams, body: confirmBody } }, async (request, reply) => {
    const id = request.params.id;
    const f = pageFilters(request.body);
    const note = request.body.note;
    return act(request, reply, id, f, "confirm", { note: note ?? "" }, async () => {
      const result = await confirmCase(db, id, { reviewer: session(request).reviewer, note });
      return afterReview(request, reply, id, f, result, "confirmed");
    });
  });

  app.post("/cases/:id/correct", { schema: { params: caseParams, body: correctBody } }, async (request, reply) => {
    const id = request.params.id;
    const f = pageFilters(request.body);
    // The team select is `new_team`, not `team`: `team` is the queue filter's hidden field.
    const { intent = "", new_team: team = INTENT_TEAM, note } = request.body;
    return act(request, reply, id, f, "correct", { intent, new_team: team, note: note ?? "" }, async () => {
      if (!isIntent(intent)) throw new InvalidReview("Pick the intent the case should have.");
      const chosenTeam = team === INTENT_TEAM ? defaultTeamFor(intent) : team;
      if (!isTeam(chosenTeam)) throw new InvalidReview("Pick a team, or keep the intent's team.");
      const result = await correctCase(db, id, {
        reviewer: session(request).reviewer,
        intent,
        team: chosenTeam,
        note,
      });
      return afterReview(request, reply, id, f, result, "corrected");
    });
  });

  app.post("/cases/:id/skip", { schema: { params: caseParams, body: skipBody } }, async (request, reply) => {
    const f = pageFilters(request.body);
    // Skipping is not a decision: nothing is stored, the session just leaves the case out.
    setSession(reply, addSkipped(session(request), request.params.id));
    return reply.redirect(`/review/next${filterParams(f, { done: "skipped" })}`, 303);
  });

  app.post("/cases/:id/unmask", { schema: { params: caseParams, body: unmaskBody } }, async (request, reply) => {
    const id = request.params.id;
    const f = pageFilters(request.body);
    // `unmask_reason`, not `reason`: `reason` is the queue filter's hidden field.
    const reason = request.body.unmask_reason;
    const reviewer = session(request).reviewer;
    return act(request, reply, id, f, "unmask", { unmask_reason: reason ?? "" }, async () => {
      // unmaskCase writes the unmask_log row before it returns the text.
      const text = await unmaskCase(db, id, { reviewer, reason });
      const view = await readCaseView(db, id);
      const logged = view.unmaskings.at(-1)!;
      return renderCase(request, reply, id, f, {
        rawText: { text, reviewer: logged.reviewer, at: logged.unmaskedAt },
      });
    });
  });

  app.get("/reviewed", { schema: { querystring: reviewedQuery } }, async (request, reply) => {
    const q = request.query;
    const filters = { reviewer: q.reviewer || undefined, decision: q.decision || undefined };
    const rows = await listReviewed(db, filters, { before: q.before, limit: PAGE_SIZE });
    return sendPage(
      reply,
      200,
      reviewedPage({
        viewer: viewerOf(session(request)),
        filters,
        rows,
        nextBefore: rows.length === PAGE_SIZE ? rows.at(-1)!.reviewId : null,
      }),
    );
  });

  done();
};
