# Phase 9 — Review queue (CLI): Requirements

## Context

This is phase P09 in [roadmap.md](../../roadmap.md). Since P08, every stored message ends as exactly one **case**: a target team, a review flag and reason codes, with a decision log. About half of the dataset's cases need review (P07 and P08 results), but nobody can act on that yet: there is no way to see the queue, look at a case, or record what a person decided.

This phase builds step 8 of [mission.md](../../mission.md), the **review queue**: people confirm or correct the cases waiting for review, and their decisions are stored. It serves these principles:

- **People decide the hard cases:** the review queue is where they do it.
- **Auditable:** every decision records who made it, when and why, and the case itself is never edited.
- **Privacy by design:** the reviewer sees masked text by default; seeing the raw text is a deliberate, logged step.

It is CLI first, as [tech-stack.md](../../tech-stack.md) ("Review queue") says. P13 adds a minimal web page with the same actions, so the logic lives in a module the page can reuse.

## Scope

In scope:

- **`npm run review`**: an interactive loop over the review queue (see The review loop).
- **Review logic** in `src/review/`, independent of the terminal: building the queue, reading a case with its evidence, confirming, correcting and unmasking. P13's web page will call the same functions.
- **Storage** (migration `0008`):
  - `reviews`: at most one per case, never updated;
  - `unmask_log`: one row each time a reviewer views a message's raw text, never updated.
- **Spot checks:** with `--spot-check`, the loop goes through auto-routed cases (no review needed) that nobody has reviewed yet. They are confirmed or corrected the same way.
- **Tests:** unit tests for the review rules and the screen layout; integration tests for the migration, the review functions and the loop, driven by scripted input.
- **Docs:** [tech-stack.md](../../tech-stack.md) (the final `reviews` and new `unmask_log` fields, the review queue) and the README. Approving this spec approves these edits.

Out of scope (later phases):

- The review web page (P13).
- Acting on a correction: re-routing the case, notifying the team, or writing to the mock CRM. A review records the decision; what the team then sees is "the corrected team" (see Effective decision).
- Learning from corrections, or reporting correction rates in the evaluation (P17 and "Ideas for later").
- Authentication or access control. The reviewer handle is recorded, not verified (see Notes).
- Correcting urgency, service type, area or the summary. Only intent and team (decided during spec review).
- A paid run other than the demo.

## The review loop

`npm run review -- [--reviewer <handle>] [--team <team>] [--reason <code>] [--spot-check]`

- **The reviewer** comes from `--reviewer`, or else `REVIEWER` in `.env`. It is required, because every action except skip and quit is attributed. A handle is 2–32 characters of lower-case letters, digits, `.`, `_` and `-` (for example `reviewer-1`); real names are not expected.
- **The queue:**
  - by default, cases with `needs_review` and no review;
  - with `--spot-check`, cases **without** `needs_review` and no review;
  - optionally narrowed by `--team` (the case's target team) and `--reason` (one reason code).

  Oldest case first. The queue is read again before each case, so a case another reviewer finished in the meantime is not shown.
- **Each case** is shown on one screen (see What `show` prints), then the prompt:

  ```
  [c]onfirm  co[r]rect  [s]kip  [u]nmask  [q]uit >
  ```

  - **confirm:** asks for an optional note, then stores the review.
  - **correct:** lists the six intents by number; the reviewer picks one. The team defaults to that intent's team (`INTENT_TO_TEAM`); the reviewer can accept it or pick another team from a numbered list. A note is **required**. A correction must change the intent, the team or both compared to the case; otherwise it says to confirm instead.
  - **skip:** moves to the next case. Skipped cases come back in the next session; skips are not stored.
  - **unmask:** asks for a reason (required), writes an `unmask_log` row, then prints the raw message text below the case and shows the prompt again.
  - **quit:** ends the session.
- **When the queue is empty**, the loop says so and exits. At exit it prints a summary: confirmed, corrected, skipped and unmasked counts.
- **Another reviewer first:** if a review was stored for the case between showing it and deciding, the loop prints "already reviewed by `<handle>` at `<time>`" and moves on. Nothing is overwritten.
- **Input** is read line by line, so the loop works with piped input as well as a terminal. End of input counts as quit.

### What `show` prints

All from stored data; no model is called.

- The case: ID, position in the queue ("3 of 41"), interaction ID and `external_id`, channel, language, `received_at`.
- The decision: target team, review flag, and every reason code with its detail.
- The classification: outcome; for a valid one, intent, confidence, urgency, service type, area and the summary.
- The **masked** message text. A failure case that failed at masking has none; it says so and points to unmask.
- Evidence from the enrichment:
  - the customer lookup outcome; for a found customer, its ID, segment and services (type, tariff, area, status); for an ambiguous one, the candidates and the placeholders that matched each;
  - placeholders that matched no customer;
  - the area, where it came from, and matching outages.
- The decision log: one line per step, as `npm run route` prints it.
- Earlier unmaskings of this case: reviewer, time and reason.

Identifier values never appear in this screen; only `unmask` prints them, inside the raw text.

## Unmasking

Decided during spec review, after discussing what unmasking means for the masking work.

- **Masking is not undone by this.** Masking (P05) exists so personal data never reaches a **model**. The reviewer is staff allowed to see it, and the raw text is stored in PostgreSQL anyway. Showing it to a person is a different boundary.
- **It is still the exception.** Raw values end up in terminal scrollback and pasted output. Some cases need them, for example to search for a customer the CRM didn't find, so `show` is masked by default and unmasking is a separate, recorded action.
- **Every unmask is logged** in `unmask_log` with the case, the reviewer, a reason (required) and the time, before the text is printed. `show` lists earlier unmaskings, so the next reviewer sees them too.
- **What this is not:** access control. Anyone with database access can read `raw_text`. Real access control needs authentication, which a local CLI doesn't have; the log makes honest use visible and auditable.

## Effective decision

A case is written once and never changed. The decision that counts for a reviewed case is:

- **confirmed:** the case's team and the classification's intent;
- **corrected:** the review's `corrected_intent` and `corrected_team`.

`effectiveDecision(case, review)` in `src/review/` returns this, so P13 and later phases read it the same way. Cases without a review are "pending" (needs review) or "auto-routed".

## Data

### Migration `0008`: `reviews` and `unmask_log`

`reviews`: at most one per case, written once.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` (uuidv7) | |
| `case_id` | `uuid` FK, **unique** | One review per case. A second is refused. |
| `reviewer` | `text` | The handle (checked: `^[a-z0-9][a-z0-9._-]{1,31}$`) |
| `decision` | `text` | `confirmed` \| `corrected` (checked) |
| `corrected_intent` | `text`, nullable | One of `INTENTS` (checked); set exactly when `corrected` |
| `corrected_team` | `text`, nullable | One of `TEAMS` (checked); set exactly when `corrected` |
| `note` | `text`, nullable | Up to 1000 characters; required when `corrected` (checked) |
| `spot_check` | `boolean` | True when the case didn't need review (copied from the case, for counting) |
| `reviewed_at` | `timestamptz` | |

- A correction stores **both** final values, even when only one changed, so the effective decision is read from one row.
- "The correction changes something" is checked in code, because the original intent lives in `classifications`.

`unmask_log`: one row per unmask, never updated or deleted.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` (uuidv7) | |
| `case_id` | `uuid` FK | |
| `reviewer` | `text` | The handle (same check as `reviews`) |
| `reason` | `text` | 3–500 characters (checked) |
| `unmasked_at` | `timestamptz` | |

Indexes: `reviews(reviewer)`, `unmask_log(case_id)`, `unmask_log(reviewer)`.

`interactions.status` doesn't change: the review state is "has a review row", which avoids keeping two facts in step.

## Decisions

### Requirements

| Decision | Choice | Why |
| --- | --- | --- |
| What can be corrected | Intent and team. Picking an intent defaults the team to its team; the team can be overridden. | Matches tech-stack's "corrected intent/team"; a corrected intent is the useful signal for later tuning. Decided during spec review. |
| Reviews per case | One, final (unique per case); a second is refused with who and when | Simple to reason about and concurrency-safe, like cases. Decided during spec review. |
| Reviewer | A required handle (`--reviewer` or `REVIEWER`) | Every decision is attributable. Decided during spec review. |
| Message text | Masked by default; `unmask` needs a reason and is logged in `unmask_log` | Masking protects the model boundary; unmasking for staff is allowed but recorded. Decided during spec review. |
| Queue scope | Pending cases, plus `--spot-check` for auto-routed ones; filters by team and reason | Spot checks show what auto-routing gets wrong. Decided during spec review. |
| Notes | Required on a correction, optional on a confirmation | The reason for a correction is what later tuning needs. Decided during spec review. |

### Plan

| Decision | Choice | Why |
| --- | --- | --- |
| CLI shape | An interactive loop: confirm, correct, skip, unmask, quit | Decided during spec review. |
| Code shape | Logic in `src/review/` (queue, case view, actions); the loop in `src/review/cli.ts` with injected input and output streams | P13's page reuses the logic; the loop is tested with scripted input. |
| Concurrent reviewers | `ON CONFLICT (case_id) DO NOTHING`, then read the winner's review | Same pattern as cases (P07). |
| Skips | Kept in memory for the session only | A skip is not a decision. |

### Validation

| Decision | Choice | Why |
| --- | --- | --- |
| Loop tests | Integration tests drive the loop with scripted keystrokes against a real database | Decided during spec review. |
| Demo | About 8 messages processed by the worker on a separate demo database (~$0.06, after asking), then a review session | The real end-to-end flow. Decided during spec review. |

## Notes

- **The handle is not verified.** Anyone running the CLI can type any handle. This is enough for a local tool and for the audit trail's honest use, and it is the same trust level as database access. P13 has the same limitation unless a later phase adds authentication.
- **Failure cases** (`processing_failed`) are in the queue like any other. They may have no classification or masked text; the screen says what is missing, and correcting gives them an intent for the first time.
- **The demo's session is driven by piped input** so its output can go in the PR description. The loop also runs in a terminal, which the user can try.

## Implementation notes

- **The case view leaves out the classification's identifiers.** The stored classification carries `fields.identifiers` with the actual values (they come from the masking map, P05). An integration test caught this, so the case view holds a reduced classification (outcome, intent, confidence, urgency, service type, area, summary, errors, prompt and model) with no identifiers. The found customer is shown by ID, segment and services, not by customer number, for the same reason.
- **Decision-log lines moved to `src/format/decision-log.ts`**, shared by `npm run route`, `npm run process` and the review screen.
- **`--reason` uses jsonb containment** (`reason_codes @> '["code"]'`).
- **The loop reads lines with `node:readline`'s async iterator** and writes its own prompts, so end of input is a plain "no more lines" (quit) instead of a rejected question. With piped input the answers aren't echoed, which is why the demo output shows prompts run together.
- **A correction whose only problem is a missing note asks for the note again**; any other refusal (for example a correction that changes nothing) goes back to the action prompt.

## Results (recorded during implementation)

- **Tests:** 752 unit tests and 168 integration tests pass locally, including 11 tests that drive the loop with scripted input.
- **Demo** on a separate `triage_demo` database with Redis database 1 and the API on port 3001, after `crm:seed`; dropped and flushed afterwards. Eight dataset messages went through the API and the worker; the 8 classifications cost **$0.102** (the spec estimated $0.06).

  | Message | Team | Reasons |
  | --- | --- | --- |
  | msg-011 | `technical_support` | none (auto-routed; ongoing outage in Opava) |
  | msg-013 | `retention` | `cancellation` |
  | msg-010 | `complaints` | `complaint` |
  | msg-082 | `general` | `low_confidence` (0.45) |
  | msg-001 | `complaints` | `complaint`, `customer_not_found` |
  | msg-022 | `billing` | `customer_ambiguous` |
  | msg-008 | `general` | `crm_mismatch_unmatched_key` |
  | msg-007 | `technical_support` | `customer_unidentified` |

  Three review sessions with piped input:

  1. `reviewer-1`, 7 pending cases: unmasked msg-008 (reason "check which e-mail address the customer means") and confirmed it; confirmed msg-007; skipped msg-001; corrected msg-010's team only (complaint → `billing`); corrected msg-022's intent (→ complaint, default team `complaints`); confirmed msg-013; quit at msg-082. Summary: 3 confirmed, 2 corrected, 1 skipped, 1 unmasked.
  2. `reviewer-2` (from `REVIEWER`), `--spot-check`: confirmed the auto-routed msg-011 ("ongoing outage in the area explains it"); `spot_check` is true on its review.
  3. A new session showed "Case 1 of 2": the skipped msg-001 is back, with msg-082.

  The model's classifications all looked right, so **both corrections were made only to show the flow**, and their notes say so. Six `reviews` rows and one `unmask_log` row were stored as expected.
