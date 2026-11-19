# Phase 9 — Review queue (CLI): Plan

See [requirements.md](requirements.md) for scope and decisions, and [validation.md](validation.md) for the merge checklist.

**The only model calls are the demo's 8 classifications in group 6, and only after asking.** After every group, `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` pass. `npm run test:integration` must also pass after groups that touch the database.

## 1. Migration and types

1.1. Migration `src/db/migrations/0008_reviews.ts` with `reviews` and `unmask_log`, following requirements.md (Migration `0008`): the checks on handle, decision, intent, team, note and reason; the unique `case_id` on `reviews`; the indexes. Value lists written out, as in earlier migrations.

1.2. Add `ReviewsTable` and `UnmaskLogTable` to `src/db/database.ts`, and `REVIEW_DECISIONS` and `REVIEWER_PATTERN` to `src/review/rules.ts` (with a test that the pattern matches the migration's check).

1.3. Integration tests (`test/integration/migrations.int.test.ts`, a new `test/integration/reviews.int.test.ts`): the migration round trip; the database rejects a second review of a case, a bad handle, a `corrected` review without intent, team or note, a `confirmed` review with corrected values, an unknown intent or team, and an unmask reason that is too short.

## 2. Review rules (pure)

2.1. `src/review/rules.ts`:
  - `parseReviewer(text)`: the handle or a clear error;
  - `validateCorrection({ caseIntent, caseTeam, intent, team, note })`: the note is required (trimmed, 1–1000 characters), and intent or team must differ from the case;
  - `defaultTeamFor(intent)` (`INTENT_TO_TEAM`);
  - `effectiveDecision(case, classification, review)`: requirements.md (Effective decision), with status `pending`, `auto-routed`, `confirmed` or `corrected`.

2.2. Unit tests (`test/review/rules.test.ts`) for each rule, including a failure case with no classification (its intent is null, so any intent is a change).

## 3. Review functions with storage

3.1. `src/review/queue.ts`: `nextCase(db, { spotCheck, team, reason, exclude })` (oldest unreviewed case matching the filters, skipping the session's skipped IDs) and `queueSize(db, filters)`.

3.2. `src/review/case-view.ts`: `readCaseView(db, caseId)` gathers everything requirements.md (What `show` prints) lists: the case with its log (`readCase`), the interaction's channel, language, `received_at`, `external_id` and masked text, the classification used, the enrichment with its customer details (`customerDetails`) and outages (`outagesByIds`), the review if any, and earlier unmaskings. No raw text.

3.3. `src/review/actions.ts`:
  - `confirmCase(db, caseId, { reviewer, note })` and `correctCase(db, caseId, { reviewer, intent, team, note })`: validate, insert with `ON CONFLICT (case_id) DO NOTHING`, and return `{ stored: true, review }` or `{ stored: false, existing }`;
  - `unmaskCase(db, caseId, { reviewer, reason })`: inserts the `unmask_log` row first, then returns the raw text.

3.4. Integration tests (`test/integration/reviews.int.test.ts`), on cases built as in `cases.int.test.ts` and `process.int.test.ts`:
  - the queue: pending only by default, auto-routed only with `spotCheck`, the team and reason filters, oldest first, reviewed and excluded cases left out;
  - the case view of a found customer, an ambiguous one, a not-found one with an unmatched placeholder, and a `processing_failed` case without masked text;
  - the case view contains no identifier value and no raw text;
  - confirm and correct store one review each, with `spot_check` copied from the case;
  - a second review, and two concurrent ones, leave one row and return the existing review;
  - unmask writes the log row before returning the text, and the next case view lists it.

## 4. The interactive loop

4.1. `src/review/screen.ts`: pure functions that turn a case view into the lines of requirements.md (What `show` prints), plus the prompt and the numbered intent and team lists. Reuse the route CLI's decision-log lines (move `describeStep` from `src/cli/route.ts` to `src/review/screen.ts` or a shared module, and import it in both).

4.2. `src/review/cli.ts`: `runReview(argv, { db, env, input, output })` with `node:readline/promises` on the injected streams:
  - parse flags; resolve the reviewer; print usage errors with exit code 2;
  - loop: `nextCase`, print the screen and position, read the action, run it, and print the result ("confirmed", "corrected to …", "already reviewed by … at …");
  - correct: the intent list, the team defaulting to the intent's team (Enter accepts), the note; invalid input asks again; empty input at the intent prompt cancels back to the action prompt;
  - unmask: the reason, then the raw text, then the action prompt again;
  - end of input or `q` quits; print the session summary.

  The script `review` (`tsx --env-file-if-exists=.env src/review/cli.ts`). `.env.example` gains `REVIEWER=`.

4.3. Unit tests for `screen.ts` (`test/review/screen.test.ts`): a full screen for a fixture case view, a failure case, and no identifier value in the output.

4.4. Integration tests for the loop (`test/integration/review-cli.int.test.ts`), with a `PassThrough` input fed line by line and the output captured:
  - confirm with a note, then the next case is shown;
  - correct with a new intent and the default team; correct with a team override; a correction without a note asks again; a correction that changes nothing is refused;
  - skip moves on and the case is still pending afterwards;
  - unmask asks for a reason, writes the log row and prints the raw text;
  - another reviewer stores a review while the case is on screen → "already reviewed by …";
  - `--spot-check`, `--team` and `--reason` select the right cases;
  - no reviewer → exit code 2; an empty queue says so; end of input ends the session with its summary.

## 5. Docs

5.1. Update [tech-stack.md](../../tech-stack.md):
  - "Data model": the final `reviews` fields and the new `unmask_log`;
  - "Review queue": the interactive loop, spot checks, unmasking with its log, and that the logic in `src/review/` is shared with P13.

5.2. Update `README.md`: a "Reviewing cases" section with `npm run review`, the actions, `REVIEWER`, spot checks and what unmasking records.

## 6. Verify and demo

6.1. Run lint, format check, type check, unit tests, build, audit, `db:migrate` and the integration tests.

6.2. Demo on a separate `triage_demo` database with Redis database 1, as in P08: `crm:seed`, the API on port 3001, the worker, and then, **after asking** (about $0.06), 8 dataset messages posted through the API:
  - one auto-routed;
  - a cancellation, a complaint and a low-confidence message;
  - a customer not found, an ambiguous customer and a CRM mismatch;
  - a technical fault with no identifiers.

  Pick the IDs from the P07/P08 results. Then a review session with piped input: confirm one, correct one with a new intent, correct one with only a team override, skip one, unmask one (with a reason), and a `--spot-check` session that confirms the auto-routed case. Show the `reviews` and `unmask_log` rows. Drop the database and flush Redis database 1 afterwards. Keep the output for the PR description.

6.3. Record results in requirements.md (Results). Work through [validation.md](validation.md). After review, mark P09 done in [roadmap.md](../../roadmap.md), push, open the PR and ask before merging.
