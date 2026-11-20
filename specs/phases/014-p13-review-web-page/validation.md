# Phase 13 — Review web page: Validation

The branch `p13-review-web-page` can be merged when every check below passes.

How each check is marked:

- **(test):** automated in Vitest.
  - Unit tests run with `npm test`.
  - Integration tests are under `test/integration/` and run with `npm run test:integration`.
- **(ci):** a step in the GitHub Actions workflow that must be green on the pull request.
- **(manual):** needs a command or human judgement.

## Checks pass

- [x] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build` and `npm run audit` pass, with `@fastify/cookie` and `@fastify/formbody` installed. **(ci)**
- [x] `npm test` passes with no `ANTHROPIC_API_KEY` and no network; no test calls a model. **(ci)**
- [x] `npm run test:integration` passes locally and in CI. **(ci)** Green on PR #15, with `eval` (18/18 intents, 6/6 must-review).

## Configuration

- [x] `REVIEW_API_KEY` is optional; when set it must have at least 32 characters, or the server exits with a message saying so. **(test)**
- [x] Without `REVIEW_API_KEY`, `/review` answers 404 and the intake API works as before. **(test)**
- [x] `.env.example` and the Compose `app` service include `REVIEW_API_KEY`. **(manual)**

## Access and sessions

- [x] Login with a wrong key gives 401, with a bad handle 400, and sets no cookie. **(test)**
- [x] A good login sets `review_session` with `HttpOnly`, `SameSite=Strict` and `Path=/review`, and redirects to `/review`. **(test)**
- [x] Without a valid session (none, tampered, expired, or signed with another key), a `GET` redirects to the login page and a `POST` gives 401. **(test)**
- [x] A `POST` with a missing or wrong CSRF token gives 403 and stores nothing. **(test)**
- [x] Logout clears the cookie. **(test)**

## Safe rendering

- [x] `html` escapes `&`, `<`, `>`, `"` and `'` in every interpolated value; only nested `html` results pass through unescaped. **(test)**
- [x] A message, summary or finding containing `<script>` is shown escaped on the case page and in the unmask response. **(test)**
- [x] Every `/review` response has `Content-Security-Policy` (with `default-src 'none'` and no script source), `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. **(test)**
- [x] No page contains a `<script>` element or an inline event handler. **(test)**
- [x] The queue list, case page and reviewed list contain no identifier value and no raw text. **(test)**
- [x] Cookies and form bodies are not logged (`cookie` and `set-cookie` redacted). **(test)**

## Queue and case page

- [x] The queue list shows pending cases by default and auto-routed ones with `spot_check=1`; `team` and `reason` narrow it; oldest first; the count matches `queueSize`; skipped cases are marked. An unknown filter value gives 400. **(test)**
- [x] `/review/next` redirects to the oldest case in the queue, leaving out the session's skipped cases, and shows "No cases to review" when there is none. **(test)**
- [x] The case page shows the case, the decision with every reason and its detail, the classification and summary, the masked text, the enrichment evidence, the investigation, the decision log and earlier unmaskings. **(test)**
- [x] A `processing_failed` case without masked text or classification is shown, with what is missing. **(test)**
- [x] A reviewed case shows its review and no forms. An unknown case ID gives 404. **(test)**

## Actions

- [x] Confirm and correct store exactly one review with the session's reviewer and `spot_check` from the case, then redirect to the next case keeping the filters. **(test)**
- [x] Correcting with "the intent's team" stores `defaultTeamFor(intent)`; picking a team stores that team. **(test)**
- [x] A correction without a note, or one that changes nothing, gives 400 with the error on the form and stores nothing. **(test)**
- [x] A second review of a case, one after the other or as two concurrent posts, gives 409 with the first reviewer and time; one row remains. **(test)**
- [x] Skip stores nothing, the next case is another one, and the skipped case comes back after a new login. **(test)**
- [x] Unmask with a too-short reason gives 400 and writes nothing; with a good reason it writes the `unmask_log` row and the response holds the raw text; the next `GET` of the case is masked and lists the unmasking. **(test)**

## Reviewed list

- [x] The reviewed list shows reviews newest first with the effective intent and team (and the original ones when corrected); `reviewer` and `decision` filter it. **(test)**

## The page in a browser

- [x] Login, the queue with filters, the case page, confirm, correct, skip, unmask, the reviewed list and logout work in a real browser and are readable without a stylesheet framework. **(manual)** Checked by the user in Chrome.

## Demo

- [x] On a separate demo database, after the user's go-ahead (estimated at $0.10; it cost $0.144), 8 messages processed by the worker are reviewed in the browser: one confirmed, one corrected with a new intent, one with a team override, one skipped, one unmasked, and the auto-routed case spot-checked. Screenshots and the `reviews` and `unmask_log` rows are in the PR description. **(manual)**

## Specs updated

- [x] [tech-stack.md](../../tech-stack.md) describes the review page (HTTP API row, "Review queue"). **(manual)**
- [x] `README.md` explains how to open the review page, log in, and what unmasking records. **(manual)**
- [x] P13 is marked done in [roadmap.md](../../roadmap.md) after review. **(manual)**

## Scope checks

- [x] The CLI (`npm run review`) still passes its tests; `src/review/` logic is reused, not copied. **(test)** Its tests changed only by moving the case-view fixture to `test/support/` and adding the "1 turn" case.
- [x] No review changes a case, re-routes it or writes to the mock CRM; no route edits or deletes a review. **(manual)**
- [x] No JavaScript, frontend framework or template engine is added. **(manual)**
- [x] The prompts and `summary-judge.v1` are unchanged (registry hashes unchanged). **(test)**
- [x] No model call outside the demo's 8 messages (8 classifications and 2 investigations by the worker). **(manual)**
