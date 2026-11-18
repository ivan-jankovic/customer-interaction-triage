import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

describe("test setup", () => {
  it("forbids constructing a real Anthropic client", () => {
    expect(() => new Anthropic()).toThrow(/must not construct/);
  });
});
