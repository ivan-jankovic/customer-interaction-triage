// Unit tests never call a model (CLAUDE.md). The SDK is replaced by a stub that
// throws on construction, so a test that forgets to inject a mocked client fails
// loudly instead of spending money or reaching the network.
import { vi } from "vitest";

vi.mock("@anthropic-ai/sdk", () => {
  class ForbiddenAnthropic {
    constructor() {
      throw new Error("Unit tests must not construct a real Anthropic client; inject a mock LlmClient.");
    }
  }
  return { default: ForbiddenAnthropic, Anthropic: ForbiddenAnthropic };
});
