// The runner's retry decision (P08 requirements.md, "Transient model errors"). The runner itself
// is tested against PostgreSQL in test/integration/process.int.test.ts.

import { describe, expect, it } from "vitest";
import { afterClassify, isTransient } from "../../src/pipeline/process.js";

const error = (apiStatus: number | null | undefined) => ({ outcome: "error" as const, apiStatus });

describe("isTransient", () => {
  it.each([
    ["a connection error or timeout", null],
    ["408", 408],
    ["409", 409],
    ["429", 429],
    ["500", 500],
    ["503", 503],
    ["529 overloaded", 529],
  ])("retries %s", (_name, status) => {
    expect(isTransient(error(status))).toBe(true);
  });

  it.each([
    ["400", 400],
    ["401", 401],
    ["403", 403],
    ["404", 404],
    ["413", 413],
    ["422", 422],
    ["an error without a known cause", undefined],
  ])("does not retry %s", (_name, status) => {
    expect(isTransient(error(status))).toBe(false);
  });

  it("never retries valid or invalid outcomes (refusals and max_tokens are invalid)", () => {
    expect(isTransient({ outcome: "valid" })).toBe(false);
    expect(isTransient({ outcome: "invalid" })).toBe(false);
    expect(isTransient({ outcome: "invalid", apiStatus: 529 })).toBe(false);
  });
});

describe("afterClassify", () => {
  it("retries a transient error unless it is the final attempt", () => {
    expect(afterClassify(error(529), { finalAttempt: false })).toBe("retry");
    expect(afterClassify(error(null), { finalAttempt: false })).toBe("retry");
    expect(afterClassify(error(529), { finalAttempt: true })).toBe("continue");
  });

  it("goes on for everything else, on any attempt", () => {
    for (const finalAttempt of [false, true]) {
      expect(afterClassify(error(400), { finalAttempt })).toBe("continue");
      expect(afterClassify({ outcome: "invalid" }, { finalAttempt })).toBe("continue");
      expect(afterClassify({ outcome: "valid" }, { finalAttempt })).toBe("continue");
    }
  });
});
