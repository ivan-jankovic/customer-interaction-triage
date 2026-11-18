// Unit tests never call a model (CLAUDE.md). The SDK's client class is replaced by a stub
// that throws on construction, so a test that forgets to inject a mocked client fails
// loudly instead of spending money or reaching the network. The rest of the module, and the
// static members of the class (error classes such as Anthropic.APIError), stay real, so code
// that checks `error instanceof Anthropic.APIError` can be tested.
import { vi } from "vitest";

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class ForbiddenAnthropic {
    constructor() {
      throw new Error("Unit tests must not construct a real Anthropic client; inject a mock LlmClient.");
    }
  }
  // Static lookups (Anthropic.APIError, inherited from the SDK's base class) fall through to
  // the real class; only construction is replaced.
  Object.setPrototypeOf(ForbiddenAnthropic, actual.default);
  return { ...actual, default: ForbiddenAnthropic, Anthropic: ForbiddenAnthropic };
});
