# Phase 13 — Review web page: Requirements

## Context

This is phase P13 in [roadmap.md](../../roadmap.md). P09 built the review queue as a CLI (`npm run review`): people confirm or correct cases that need review, skip them, or unmask the raw text with a logged reason. The logic lives in `src/review/` (`queue.ts`, `case-view.ts`, `actions.ts`, `rules.ts`), independent of the terminal, so that this phase can reuse it.

This phase adds the minimal web page that [mission.md](../../mission.md) (step 8, "later a minimal web page") and [tech-stack.md](../../tech-stack.md) ("Review queue") promise: the same actions as the CLI, in a browser, server-rendered by Fastify with no frontend framework. It serves these principles:

- **People decide the hard cases:** a page is easier to use than a terminal loop for the people who do this.
- **Auditable:** every review and every unmask is stored exactly as from the CLI, through the same functions.
- **Privacy by design:** masked text by default; the raw text is shown only in the response to a logged unmask.
- **Untrusted input:** message text, summaries and evidence can contain HTML or instructions (P11). Everything is escaped, and the page runs no script.

The mission's non-goal applies: **no production-grade UI**. The page is plain HTML forms with a little CSS.

## Scope

In scope:

- **Review routes** under `/review`, registered in the existing Fastify app (`buildApp`), so `npm run dev`, `npm start` and the Compose `app` service serve them (see Pages and routes).
- **Login:** a shared review key (`REVIEW_API_KEY`) plus a reviewer handle, kept in a signed session cookie (see Access and sessions).
- **The queue list** with the CLI's filters (team, reason, spot check), and "Start reviewing", which opens the oldest case in the queue.
- **The case page:** everything the CLI screen shows, including the investigation, plus forms to confirm, correct, skip and unmask.
- **A reviewed cases list:** read-only, with each case's effective decision.
- **Safe rendering:** an escaping HTML template helper, a strict Content Security Policy, no JavaScript.
- **Tests:** unit tests for the HTML helper, the session cookie and the page renderers; integration tests that drive every route through `fastify.inject` against a real database.
- **Docs:** [tech-stack.md](../../tech-stack.md) (review queue, HTTP API row, configuration), the README, `.env.example` and `docker-compose.yml` (`REVIEW_API_KEY` passed to `app`). Approving this spec approves these edits.

Out of scope (later phases):

- Per-reviewer accounts, passwords or real authentication. The handle stays unverified, as in the CLI (see Notes).
- Changing a case, re-routing it, notifying teams or writing to the mock CRM. As in P09, a review only records a decision.
- Undoing or editing a review. One review per case, final, as in P09.
- JavaScript, a frontend framework, a CSS framework, or a design beyond readable defaults.
- The README's architecture section and its screenshots of the review page (P14). This phase's demo screenshots go in the PR description.
- A queue dashboard (Bull Board) or metrics on the page ("Ideas for later").
- A paid run other than the demo.

## Access and sessions

Decided during spec review.

- **`REVIEW_API_KEY`**, at least 32 characters (the same rule as `INTAKE_API_KEY`). It is a separate key from the intake key, so the system that posts messages can't review them. When it is not set, the `/review` routes are not registered and the server logs one line saying so; intake keeps working. This keeps existing setups and the intake tests unchanged.
- **Login** (`GET`/`POST /review/login`): a form with the key and a handle. The key is compared in constant time (as `sameKey` in `src/api/app.ts`); the handle is checked with `parseReviewer` (`^[a-z0-9][a-z0-9._-]{1,31}$`). A wrong key or bad handle re-renders the form with a generic or specific error (the key error never says how close it was), status 401 or 400.
- **The session** is one cookie, `review_session`, signed with `@fastify/cookie` (HMAC), with `HttpOnly`, `SameSite=Strict`, `Path=/review`, and `Secure` when the request came over HTTPS. It holds the reviewer handle, a random CSRF token, the session's skipped case IDs and an expiry time. The signing secret is derived from `REVIEW_API_KEY` (HMAC with a fixed label), so changing the key logs everyone out and no second secret is needed.
- **Expiry:** 8 hours after login. An expired, unsigned or malformed cookie is treated as no session.
- **Every other `/review` route** needs a valid session. A `GET` without one redirects to the login page (303); a `POST` without one gets 401.
- **CSRF:** every form carries the session's token in a hidden field; a `POST` whose token doesn't match gets 403 and changes nothing. This is on top of `SameSite=Strict`.
- **Logout** (`POST /review/logout`) clears the cookie.

The handle is still what the reviewer types; the key only keeps the page from being open to anyone who can reach the port.

## Pages and routes

All under `/review`. Every page shows the reviewer's handle and a logout button. Lists show at most 50 rows, with a link to the next 50.

| Route | What it does |
| --- | --- |
| `GET /review/login`, `POST /review/login` | The login form; on success, sets the cookie and redirects to `/review`. |
| `POST /review/logout` | Clears the cookie, redirects to the login page. |
| `GET /review` | **The queue list** (see below). |
| `GET /review/next` | Redirects (303) to the oldest case in the queue for the given filters, leaving out the session's skipped cases (`nextCase` with `exclude`). When the queue is empty, renders "No cases to review" with a link back. |
| `GET /review/cases/:id` | **The case page** (see below). 404 for an unknown or malformed ID. |
| `POST /review/cases/:id/confirm` | Optional note. Stores the review with `confirmCase`, then redirects to `/review/next` with the same filters and a notice ("Case … confirmed"). |
| `POST /review/cases/:id/correct` | Intent, team and a required note. Stores it with `correctCase`, then redirects as confirm does. |
| `POST /review/cases/:id/skip` | Adds the case to the session's skipped IDs, then redirects to `/review/next`. Nothing is stored in the database. |
| `POST /review/cases/:id/unmask` | A required reason. Calls `unmaskCase` (which writes `unmask_log` first) and renders the case page with the raw text in that response only. |
| `GET /review/reviewed` | **The reviewed cases list** (see below). |
| `GET /review/style.css` | The stylesheet (a constant string in code). |

The filters are query parameters, carried through every link and redirect of the session: `team` (one of `TEAMS`), `reason` (one of `REASON_CODES`), `spot_check` (`1`). Unknown values get 400.

### The queue list

- A filter form (team, reason, spot check) and the number of cases in the queue (`queueSize`).
- One row per unreviewed case, oldest first: case ID (linked), received at, channel, language, intent and confidence (or the classification outcome), target team, reason codes. Skipped cases are marked "skipped".
- "Start reviewing" links to `/review/next` with the filters.
- Links to the reviewed list and back to the queue on every page.

### The case page

Everything the CLI screen shows (P09 requirements.md, "What `show` prints"), from `readCaseView`, in sections:

- **Case:** ID, position in the queue when the case is in it ("3 of 41"), interaction ID, `external_id`, channel, language, received at.
- **Decision:** target team, review flag, each reason code with its detail.
- **Classification:** outcome; for a valid one, intent, confidence, urgency, service type, area and summary; errors for an invalid one; prompt version and model.
- **Message:** the masked text, in a `<pre>` block. A failure case without masked text says so and points to unmask.
- **Evidence:** the customer lookup outcome; a found customer's ID, segment and services; ambiguous candidates with the placeholders that matched each; unmatched placeholders; the area and its source; matching outages.
- **Investigation** (decided during spec review): for a technical fault, the outcome, likely cause, confidence, summary, evidence (tool and finding), steps, and tool calls (turn, tool, input, error flag), or why it was skipped.
- **Decision log:** one line per step, with `describeStep` from `src/format/decision-log.ts`.
- **Unmaskings:** earlier unmaskings, with reviewer, time and reason.
- **Review:** if the case is reviewed, the review (reviewer, time, decision, corrected intent and team, note) and **no forms**. Otherwise the forms:
  - **Confirm:** an optional note.
  - **Correct:** an intent select (current intent marked), a team select, and a required note. With no JavaScript the team can't follow the intent as you pick it, so the team select has an extra first option, "the intent's team", which is the default and means `defaultTeamFor(intent)`. This matches the CLI, where Enter accepts the intent's team.
  - **Skip** and **Unmask** (a required reason).

Identifier values never appear on the case page or the lists, as in the CLI. The raw text appears only in the `unmask` response, under a clear heading ("Raw text, unmask logged at … by …"). Reloading the case page shows it masked again, so every view of the raw text has a log row (decided during spec review).

### Outcomes of an action

- **Stored:** redirect (303) to the next case, with a notice on that page.
- **Invalid input** (no note on a correction, a correction that changes nothing, a reason that is too short, an unknown intent or team): status 400, the case page again with the error next to the form and the entered values kept.
- **Already reviewed** (another reviewer was first, or a second post): status 409, the case page showing "Already reviewed by `<handle>` at `<time>`" and the stored review. Nothing is overwritten.

### The reviewed cases list

Read-only, newest review first: case ID (linked to the case page, which then shows the review and no forms), reviewed at, reviewer, decision, spot check, and the effective intent and team (`effectiveDecision`), with the original intent and team when corrected. Optional filters: `reviewer` and `decision`.

## Safe rendering

Message text is untrusted (P11), and so are summaries, findings and notes.

- **One HTML helper** in `src/review/web/html.ts`: a tagged template `html\`…\`` that escapes every interpolated value (`&`, `<`, `>`, `"`, `'`), joins arrays, and leaves alone only values wrapped by the helper itself (nested `html` results). There is no other way to put markup into a page.
- **No JavaScript** on any page, and a Content Security Policy that forbids it: `default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`.
- **Headers on every `/review` response:** `Cache-Control: no-store` (the unmask response holds raw personal data), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
- **Logs:** Fastify logs the method and URL only, as for intake. Form bodies (notes, reasons, the key) are never logged, and `cookie` and `set-cookie` headers are redacted.

## Decisions

### Requirements

| Decision | Choice | Why |
| --- | --- | --- |
| Who can open the page | A shared `REVIEW_API_KEY` at login, plus an unverified handle, in a signed session cookie | The page isn't open to anyone on the port; the handle has the same trust level as in the CLI. Decided during spec review. |
| Pages beyond the CLI's actions | Filters in the queue list, a reviewed cases list, the investigation on the case page | Decided during spec review. |
| Unmask | A POST with a required reason; the raw text is shown in that response only | Every view of the raw text is logged, as in the CLI. Decided during spec review. |
| Skip | Skipped case IDs kept in the session cookie (at most 50, the oldest dropped first) until logout or expiry; not stored | Like a CLI session: skipped cases come back next session. Decided during spec review. |
| Without `REVIEW_API_KEY` | The review routes are not registered; intake works as before | Existing `.env` files and intake tests keep working; the review page is opt-in. |
| Correcting the team without JavaScript | A team option "the intent's team" as the default | Same behaviour as the CLI's default team, without a script. |

### Plan

| Decision | Choice | Why |
| --- | --- | --- |
| Where it runs | The same Fastify app, as a plugin under `/review` | One server, one Compose service; the intake key and the review login stay separate. Decided during spec review. |
| HTML rendering | A small escaping tagged template, no template engine | No new dependency; escaping is the default, which matters for untrusted text. Decided during spec review. |
| Forms and cookies | `@fastify/formbody` and `@fastify/cookie` (signed, `HttpOnly`, `SameSite=Strict`), plus a per-session CSRF token | The official plugins, and defence in depth against forged confirm and unmask posts. Decided during spec review. |
| Review logic | Reused from `src/review/` unchanged (`nextCase`, `queueSize`, `readCaseView`, `confirmCase`, `correctCase`, `unmaskCase`, `effectiveDecision`) | Same rules and storage as the CLI. Only a list of reviewed cases is new. |

### Validation

| Decision | Choice | Why |
| --- | --- | --- |
| Tests | Integration tests through `fastify.inject` against a real database, for every route, plus unit tests for the helper, session and renderers | Decided during spec review. No browser test dependency. |
| Demo | About 8 messages processed by the worker on a separate demo database (about $0.10, after asking), then reviewed in a browser, with screenshots in the PR | The real end-to-end flow, as in P09. Decided during spec review. |

## Notes

- **The handle is still not verified.** Anyone with the review key can type any handle. This is the CLI's trust level plus a key at the door; real accounts would need a users table and password handling, which the mission's "minimal page" doesn't call for.
- **No rate limit on login.** The server listens on `127.0.0.1` locally and in Compose, and the key has at least 32 random characters. A hosted deployment would need one; there is none (tech-stack, "Local setup").
- **Two reviewers on the same case** are handled by P09's `ON CONFLICT (case_id) DO NOTHING`: the second gets the 409 page with the first review.
- **`buildApp` gains an optional `review` option** (the database and the review key). The intake unit tests don't pass it, so they don't change.
- **Docs consulted during implementation:** `@fastify/cookie` (signing, `setCookie` options) and `@fastify/formbody`, through `ctx7`. After installing them, `npm run audit` must pass.
