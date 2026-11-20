import { describe, expect, it } from "vitest";
import {
  MAX_SKIPPED,
  SESSION_TTL_MS,
  addSkipped,
  cookieSecret,
  decodeSession,
  encodeSession,
  newSession,
  sameSecret,
  type Session,
} from "../../../src/review/web/session.js";

const NOW = new Date("2026-11-20T10:00:00Z");
const id = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

describe("newSession", () => {
  it("holds the reviewer, a fresh CSRF token, no skips and an 8-hour expiry", () => {
    const s = newSession("reviewer-1", NOW);
    expect(s.reviewer).toBe("reviewer-1");
    expect(s.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.skipped).toEqual([]);
    expect(s.expiresAt).toBe(NOW.getTime() + SESSION_TTL_MS);
    expect(newSession("reviewer-1", NOW).csrf).not.toBe(s.csrf);
  });
});

describe("encodeSession and decodeSession", () => {
  const session = addSkipped(newSession("reviewer-1", NOW), id(1));

  it("round-trips a session", () => {
    const value = encodeSession(session);
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeSession(value, NOW)).toEqual(session);
  });

  it("treats an expired session as none", () => {
    expect(decodeSession(encodeSession(session), new Date(session.expiresAt))).toBeNull();
  });

  const bad = (patch: Partial<Record<keyof Session, unknown>>) =>
    Buffer.from(JSON.stringify({ ...session, ...patch })).toString("base64url");

  it.each([
    ["not base64 JSON", "%%%"],
    ["JSON that isn't an object", Buffer.from("42").toString("base64url")],
    ["a bad handle", bad({ reviewer: "Reviewer One" })],
    ["a short CSRF token", bad({ csrf: "abc" })],
    ["a skipped ID that isn't a UUID", bad({ skipped: ["nope"] })],
    ["too many skipped IDs", bad({ skipped: Array.from({ length: MAX_SKIPPED + 1 }, (_, n) => id(n)) })],
    ["a missing expiry", bad({ expiresAt: undefined })],
  ])("treats %s as none", (_label, value) => {
    expect(decodeSession(value, NOW)).toBeNull();
  });
});

describe("addSkipped", () => {
  it("adds a case once, moving a repeat to the end", () => {
    let s = newSession("reviewer-1", NOW);
    s = addSkipped(addSkipped(addSkipped(s, id(1)), id(2)), id(1));
    expect(s.skipped).toEqual([id(2), id(1)]);
  });

  it(`keeps at most ${MAX_SKIPPED}, dropping the oldest`, () => {
    let s = newSession("reviewer-1", NOW);
    for (let n = 0; n <= MAX_SKIPPED; n++) s = addSkipped(s, id(n));
    expect(s.skipped).toHaveLength(MAX_SKIPPED);
    expect(s.skipped[0]).toBe(id(1));
    expect(s.skipped.at(-1)).toBe(id(MAX_SKIPPED));
  });
});

describe("cookieSecret and sameSecret", () => {
  it("derives a stable 32-byte secret that differs per key and from the key itself", () => {
    const a = cookieSecret("a".repeat(32));
    expect(a).toHaveLength(32);
    expect(cookieSecret("a".repeat(32)).equals(a)).toBe(true);
    expect(cookieSecret("b".repeat(32)).equals(a)).toBe(false);
    expect(a.toString("utf8")).not.toContain("a".repeat(32));
  });

  it("compares secrets of any length", () => {
    expect(sameSecret("x".repeat(40), "x".repeat(40))).toBe(true);
    expect(sameSecret("x", "x".repeat(40))).toBe(false);
  });
});
