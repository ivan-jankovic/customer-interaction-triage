// Review rules (P09 requirements.md): pure functions shared by the CLI loop and, later, the
// review web page (P13). The database repeats the structural checks (migration 0008); the
// checks that need the case (a correction must change something) live only here.

import { INTENT_TO_TEAM, INTENTS, TEAMS, type Intent, type Team } from "../taxonomy.js";

export const REVIEW_DECISIONS = ["confirmed", "corrected"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** A reviewer handle such as `reviewer-1`: no real names. Same pattern as migration 0008's check. */
export const REVIEWER_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;
export const NOTE_MAX_LENGTH = 1000;
export const REASON_MIN_LENGTH = 3;
export const REASON_MAX_LENGTH = 500;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseReviewer(text: string | undefined): Checked<string> {
  const handle = text?.trim() ?? "";
  if (!handle) return { ok: false, error: "A reviewer handle is required: --reviewer <handle> or REVIEWER in .env." };
  if (!REVIEWER_PATTERN.test(handle)) {
    return {
      ok: false,
      error: `"${handle}" is not a reviewer handle: 2-32 lower-case letters, digits, ".", "_" or "-", e.g. reviewer-1.`,
    };
  }
  return { ok: true, value: handle };
}

/** A note: trimmed, null when empty, at most NOTE_MAX_LENGTH characters. */
export function parseNote(text: string | undefined): Checked<string | null> {
  const note = text?.trim() ?? "";
  if (note.length > NOTE_MAX_LENGTH)
    return { ok: false, error: `The note is longer than ${NOTE_MAX_LENGTH} characters.` };
  return { ok: true, value: note || null };
}

export function parseReason(text: string | undefined): Checked<string> {
  const reason = text?.trim() ?? "";
  if (reason.length < REASON_MIN_LENGTH || reason.length > REASON_MAX_LENGTH) {
    return { ok: false, error: `A reason of ${REASON_MIN_LENGTH}-${REASON_MAX_LENGTH} characters is required.` };
  }
  return { ok: true, value: reason };
}

export const isIntent = (v: string): v is Intent => (INTENTS as readonly string[]).includes(v);
export const isTeam = (v: string): v is Team => (TEAMS as readonly string[]).includes(v);

/** The team a corrected intent goes to unless the reviewer picks another. */
export function defaultTeamFor(intent: Intent): Team {
  return INTENT_TO_TEAM[intent];
}

export interface CorrectionInput {
  /** The classification's intent; null when there was no valid classification (e.g. a failure case). */
  caseIntent: Intent | null;
  caseTeam: Team;
  intent: Intent;
  team: Team;
  note: string | undefined;
}

/** A correction needs a note and must change the intent, the team or both. */
export function validateCorrection(c: CorrectionInput): Checked<{ intent: Intent; team: Team; note: string }> {
  const note = parseNote(c.note);
  if (!note.ok) return note;
  if (note.value === null) return { ok: false, error: "A correction needs a note saying why." };
  if (c.intent === c.caseIntent && c.team === c.caseTeam) {
    return { ok: false, error: "That is the case's own intent and team; confirm the case instead." };
  }
  return { ok: true, value: { intent: c.intent, team: c.team, note: note.value } };
}

export type ReviewStatus = "pending" | "auto-routed" | "confirmed" | "corrected";

export interface EffectiveDecision {
  status: ReviewStatus;
  intent: Intent | null;
  team: Team;
}

/**
 * The decision that counts for a case (requirements.md, "Effective decision"): a case is never
 * changed, so a correction's values come from its review; otherwise the case's team and the
 * classification's intent.
 */
export function effectiveDecision(
  c: { targetTeam: Team; needsReview: boolean },
  classificationIntent: Intent | null,
  review: { decision: ReviewDecision; correctedIntent: Intent | null; correctedTeam: Team | null } | null,
): EffectiveDecision {
  if (review?.decision === "corrected") {
    return { status: "corrected", intent: review.correctedIntent, team: review.correctedTeam! };
  }
  const status: ReviewStatus = review ? "confirmed" : c.needsReview ? "pending" : "auto-routed";
  return { status, intent: classificationIntent, team: c.targetTeam };
}
