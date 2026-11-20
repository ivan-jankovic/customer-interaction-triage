// The review page's session (P13 requirements.md, "Access and sessions"): one cookie holding the
// reviewer handle, a CSRF token, the session's skipped case IDs and an expiry time. The cookie is
// signed by @fastify/cookie (HMAC-SHA256); this module only encodes, checks and decodes the value.
// Anything that doesn't decode to a well-formed, unexpired session counts as no session.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { REVIEWER_PATTERN } from "../rules.js";

export const SESSION_COOKIE = "review_session";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** Skipped case IDs kept per session; the oldest is dropped first, so the cookie stays small. */
export const MAX_SKIPPED = 50;

export interface Session {
  reviewer: string;
  /** base64url of 32 random bytes; every form posts it back. */
  csrf: string;
  skipped: string[];
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CSRF = /^[A-Za-z0-9_-]{43}$/;

export function newSession(reviewer: string, now: Date): Session {
  return {
    reviewer,
    csrf: randomBytes(32).toString("base64url"),
    skipped: [],
    expiresAt: now.getTime() + SESSION_TTL_MS,
  };
}

/** base64url of the JSON, so the cookie value needs no further encoding. */
export function encodeSession(s: Session): string {
  return Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
}

export function decodeSession(value: string, now: Date): Session | null {
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { reviewer, csrf, skipped, expiresAt } = data as Record<string, unknown>;
  if (typeof reviewer !== "string" || !REVIEWER_PATTERN.test(reviewer)) return null;
  if (typeof csrf !== "string" || !CSRF.test(csrf)) return null;
  if (!Array.isArray(skipped) || skipped.length > MAX_SKIPPED) return null;
  if (!skipped.every((id): id is string => typeof id === "string" && UUID.test(id))) return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return null;
  return { reviewer, csrf, skipped, expiresAt };
}

export function addSkipped(s: Session, caseId: string): Session {
  const skipped = [...s.skipped.filter((id) => id !== caseId), caseId].slice(-MAX_SKIPPED);
  return { ...s, skipped };
}

/**
 * The cookie-signing secret, derived from REVIEW_API_KEY so no second secret is needed; changing
 * the key logs everyone out. The label keeps it distinct from any other use of the key.
 */
export function cookieSecret(reviewKey: string): Buffer {
  return createHmac("sha256", reviewKey).update("review-session-cookie.v1").digest();
}

/** Constant-time comparison; hashing first gives both sides the same length. */
export function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
