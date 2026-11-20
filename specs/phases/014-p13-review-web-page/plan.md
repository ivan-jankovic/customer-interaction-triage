# Phase 13 — Review web page: Plan

See [requirements.md](requirements.md) for scope and decisions, and [validation.md](validation.md) for the merge checklist.

**The only model calls are the demo's 8 classifications in group 7, and only after asking.** After every group, `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` pass. `npm run test:integration` must also pass after groups that touch the database.

## 1. Dependencies and configuration

1.1. Look up the current `@fastify/cookie` and `@fastify/formbody` docs with `ctx7` (signed cookies, `setCookie` options, the urlencoded parser). Install both; run `npm run audit`.

1.2. `src/config.ts`: `loadApiConfig` reads an optional `REVIEW_API_KEY`; when set, it must have at least `MIN_API_KEY_LENGTH` characters, with the same message style as `INTAKE_API_KEY`. Unit tests in `test/config.test.ts`: unset, too short, valid.

1.3. `.env.example` gains `REVIEW_API_KEY=` with a comment (generate with `openssl rand -hex 32`; different from `INTAKE_API_KEY`; the page is off without it). `docker-compose.yml` passes `REVIEW_API_KEY` to the `app` service.

## 2. HTML helper and session (pure)

2.1. `src/review/web/html.ts`: the tagged template `html` returning a `SafeHtml` value; interpolated strings, numbers and `null`/`undefined` (rendered empty) are escaped; arrays are joined; `SafeHtml` values pass through. A `page(title, reviewer, body, notice?)` layout with the header (handle, links to the queue and the reviewed list, logout form) and the stylesheet link.

2.2. `src/review/web/session.ts`: `Session` (`reviewer`, `csrf`, `skipped`, `expiresAt`); `newSession(reviewer, now)` (32 random bytes for the CSRF token, 8 hours); `encodeSession` and `decodeSession(value, now)` (JSON, checked shape, expired or malformed → `null`); `addSkipped(session, id)` (at most 50, oldest dropped); `cookieSecret(reviewKey)` (HMAC-SHA256 of a fixed label with the key). Signing itself is `@fastify/cookie`'s.

2.3. Unit tests (`test/review/web/html.test.ts`, `test/review/web/session.test.ts`): escaping of each special character and of `<script>` text, nesting, arrays, empty values; a session round trip, expiry, a malformed value, the skipped cap, a different key giving a different secret.

## 3. Page renderers (pure)

3.1. `src/review/web/pages.ts`, pure functions from data to `SafeHtml`:
  - `loginPage({ error?, reviewer? })`;
  - `queuePage({ filters, total, rows, skipped, next })`;
  - `casePage({ view, position, filters, csrf, errors?, values?, rawText?, notice? })`: the sections of requirements.md (The case page), the forms with the CSRF token and the filters as hidden fields, the review instead of forms when reviewed, the raw-text section only when `rawText` is given;
  - `reviewedPage({ rows, filters, next })`;
  - `emptyQueuePage({ filters })`;
  - the `STYLESHEET` constant.

  Decision-log lines come from `describeStep` (`src/format/decision-log.ts`).

3.2. Unit tests (`test/review/web/pages.test.ts`) with case-view fixtures (reuse those of `test/review/screen.test.ts` where they fit): a valid case with a found customer, an ambiguous one, a technical fault with an investigation, a `processing_failed` case without masked text or classification, a reviewed case (no forms), and:
  - masked text, a summary and a finding containing `<script>` and `"` are escaped;
  - no identifier value from the fixture appears in any page, and no raw text unless `rawText` is given;
  - every form has the CSRF field;
  - the correct form's team select defaults to "the intent's team".

## 4. Reviewed cases query

4.1. `src/review/reviewed.ts`: `listReviewed(db, { reviewer?, decision?, before?, limit })`: reviews joined to cases and classifications, newest first, with what `effectiveDecision` needs and the original intent and team.

4.2. Integration tests (`test/integration/reviews.int.test.ts`): order, the two filters, paging with `before`.

## 5. Routes

5.1. `src/review/web/routes.ts`: a Fastify plugin `reviewRoutes({ db, reviewKey })` registered under `/review`:
  - `@fastify/formbody` and `@fastify/cookie` (secret from `cookieSecret`) inside the plugin's scope;
  - an `onSend` hook adding the headers of requirements.md (Safe rendering) to every response;
  - a `preHandler` that reads the session: no session on `GET` → 303 to `/review/login`, on `POST` → 401; on a `POST`, a missing or wrong `csrf` field → 403;
  - the routes of requirements.md (Pages and routes), with Fastify JSON schemas for params, query strings and form bodies (case ID a UUID, filters from `TEAMS` and `REASON_CODES`, string lengths), going through the app's existing Ajv setup;
  - action outcomes: 303 to `/review/next` with the filters and a notice, 400 with the form errors, 409 with the existing review; `InvalidReview` → 400, `CaseNotFound` → 404.

5.2. `src/api/app.ts`: `AppOptions` gains `review?: { db: Kysely<Database>; reviewKey: string }`; when set, `buildApp` registers `reviewRoutes` with prefix `/review`. `src/api/server.ts` passes it when `REVIEW_API_KEY` is set and logs "review page disabled: REVIEW_API_KEY not set" otherwise. `LOGGER_OPTIONS` also redacts `req.headers.cookie` and `res.headers["set-cookie"]`.

5.3. Integration tests (`test/integration/review-web.int.test.ts`), with `buildApp` and `fastify.inject` against the test database, on cases built as in `reviews.int.test.ts`:
  - **access:** without `REVIEW_API_KEY`, `/review` is 404 and intake works; login with a wrong key (401), a bad handle (400) and a good one (cookie set with `HttpOnly`, `SameSite=Strict`, `Path=/review`); a `GET` without a session redirects to login; a `POST` without one is 401; a tampered, expired or other-key cookie counts as none; a `POST` with a wrong CSRF token is 403 and stores nothing; logout clears the cookie;
  - **queue:** pending cases by default, auto-routed with `spot_check=1`, `team` and `reason` filters, oldest first, skipped cases marked; an unknown filter value is 400;
  - **next:** redirects to the oldest case, leaving out skipped ones; an empty queue renders "No cases to review";
  - **case page:** shows the sections of requirements.md, including the investigation; no identifier value and no raw text; a reviewed case shows the review and no forms; an unknown ID is 404;
  - **confirm and correct:** store one review each with the reviewer from the session and `spot_check` from the case, then redirect to the next case with the filters; "the intent's team" stores `defaultTeamFor(intent)`; a correction without a note or changing nothing is 400 and stores nothing; a second review (one after the other, and two concurrent posts) is 409 with the first reviewer, and one row remains;
  - **skip:** the next case is another one; the skipped case is still pending in the database and comes back after a new login;
  - **unmask:** a short reason is 400 and writes nothing; a good one writes the `unmask_log` row and the response holds the raw text; the next `GET` of the case page is masked and lists the unmasking;
  - **reviewed list:** newest first, effective decision for confirmed and corrected cases, the filters;
  - **headers and escaping:** every `/review` response has the CSP, `no-store`, `no-referrer` and `nosniff` headers; a message containing `<script>` is rendered escaped on the case page and after unmask.

## 6. Docs

6.1. Update [tech-stack.md](../../tech-stack.md):
  - "Core", HTTP API row: Fastify also serves the review page under `/review` when `REVIEW_API_KEY` is set, with `@fastify/cookie` and `@fastify/formbody`;
  - "Review queue": replace "Later, a minimal web page (P13)" with what the page does: the login and session, the routes, unmask in the response only, safe rendering, and that it reuses `src/review/`.

6.2. Update `README.md`: a "Reviewing in the browser" part of "Reviewing cases": set `REVIEW_API_KEY`, open `http://localhost:3000/review`, log in with the key and a handle; what unmasking records.

## 7. Verify and demo

7.1. Run lint, format check, type check, unit tests, build, audit, `db:migrate` and the integration tests.

7.2. Demo on a separate `triage_demo` database with Redis database 1 and the API on port 3001, as in P09: `crm:seed`, the worker, and then, **after asking** (about $0.10), 8 dataset messages posted through the API, picked like P09's (one auto-routed; a cancellation, a complaint and a low-confidence message; customer not found, ambiguous and a CRM mismatch; a technical fault with an investigation). Then, in a browser: log in, filter the queue, confirm one, correct one with a new intent and the intent's team, correct one with a team override, skip one, unmask one with a reason, spot-check the auto-routed case, open the reviewed list, and log out. Take screenshots of the queue, a case page, the unmask response and the reviewed list for the PR description. Show the `reviews` and `unmask_log` rows. Drop the database and flush Redis database 1 afterwards.

7.3. Record results in requirements.md (Results). Work through [validation.md](validation.md). After review, mark P13 done in [roadmap.md](../../roadmap.md), push, open the PR and ask before merging.
