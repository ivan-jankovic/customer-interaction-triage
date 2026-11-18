import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createAnthropicClient } from "../../src/llm/client.js";

describe("test setup", () => {
  it("forbids constructing a real Anthropic client", () => {
    expect(() => new Anthropic()).toThrow(/must not construct/);
  });

  it("forbids it through the project's client too, when no fake SDK is passed", () => {
    expect(() => createAnthropicClient()).toThrow(/must not construct/);
  });

  it("keeps the SDK's error classes, so error handling can be tested", () => {
    expect(new Anthropic.RateLimitError(429, undefined, "slow down", new Headers())).toBeInstanceOf(Anthropic.APIError);
  });
});
