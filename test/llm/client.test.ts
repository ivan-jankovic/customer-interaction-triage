// The Anthropic client wrapper with a fake SDK object: no network, no real client.

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_BETA,
  createAnthropicClient,
  toCreateParams,
  type LlmRequest,
  type MessagesApi,
} from "../../src/llm/client.js";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

const request: LlmRequest = {
  model: "claude-opus-5-5",
  system: "system prompt",
  user: "user turn",
  schema: { type: "object", properties: { s: { type: "string", minLength: 1, enum: ["a"] } } },
  maxTokens: 4000,
  effort: "low",
};

function message(overrides: Record<string, unknown> = {}): BetaMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: '{"s":"a"}', citations: null }],
    stop_reason: "end_turn",
    stop_details: null,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 900,
      iterations: null,
    },
    ...overrides,
  } as unknown as BetaMessage;
}

function fakeSdk(respond: () => Promise<BetaMessage>) {
  const calls: unknown[] = [];
  const counted: unknown[] = [];
  const sdk: MessagesApi = {
    beta: {
      messages: {
        create: (params) => {
          calls.push(params);
          return respond();
        },
        countTokens: (params) => {
          counted.push(params);
          return Promise.resolve({ input_tokens: 1234, context_management: null });
        },
      },
    },
  };
  return { sdk, calls, counted };
}

describe("toCreateParams", () => {
  it("sends the stripped schema, effort and a cached system prompt, without fallbacks by default", () => {
    const params = toCreateParams(request);
    expect(params.system).toEqual([{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }]);
    expect(params.messages).toEqual([{ role: "user", content: "user turn" }]);
    expect(params.output_config).toEqual({
      effort: "low",
      format: { type: "json_schema", schema: { type: "object", properties: { s: { type: "string", enum: ["a"] } } } },
    });
    expect(params).not.toHaveProperty("fallbacks");
    expect(params).not.toHaveProperty("betas");
  });

  it("adds the default fallbacks and their beta only when asked", () => {
    const params = toCreateParams({ ...request, fallbacks: true });
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual([FALLBACK_BETA]);
  });
});

describe("createAnthropicClient", () => {
  it("returns the text, served model and usage", async () => {
    const { sdk } = fakeSdk(() => Promise.resolve(message()));
    const result = await createAnthropicClient(sdk).complete(request);
    expect(result).toEqual({
      ok: true,
      text: '{"s":"a"}',
      model: "claude-opus-5-5",
      fellBack: false,
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 },
    });
  });

  it("detects a fallback from usage.iterations and reports the serving model", async () => {
    const iterations = [
      {
        type: "message",
        input_tokens: 50,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      {
        type: "fallback_message",
        model: "claude-opus-4-8",
        input_tokens: 50,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: null,
      },
    ];
    const { sdk } = fakeSdk(() =>
      Promise.resolve(message({ usage: { ...message().usage, iterations }, model: "claude-opus-4-8" })),
    );
    const result = await createAnthropicClient(sdk).complete({ ...request, fallbacks: true });
    expect(result).toMatchObject({ ok: true, model: "claude-opus-4-8", fellBack: true });
  });

  it("reports a refusal with its category", async () => {
    const { sdk } = fakeSdk(() =>
      Promise.resolve(
        message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } }),
      ),
    );
    expect(await createAnthropicClient(sdk).complete(request)).toMatchObject({
      ok: false,
      failure: "refusal",
      error: "refusal (cyber)",
    });
  });

  it("reports max_tokens and keeps the truncated text", async () => {
    const { sdk } = fakeSdk(() => Promise.resolve(message({ stop_reason: "max_tokens" })));
    expect(await createAnthropicClient(sdk).complete(request)).toMatchObject({
      ok: false,
      failure: "max_tokens",
      text: '{"s":"a"}',
    });
  });

  it("turns an API error into a result instead of throwing", async () => {
    const error = new Anthropic.BadRequestError(400, { error: { message: "bad" } }, "bad request", new Headers());
    const { sdk } = fakeSdk(() => Promise.reject(error));
    expect(await createAnthropicClient(sdk).complete(request)).toMatchObject({
      ok: false,
      failure: "api_error",
      error: expect.stringContaining("API error 400") as string,
      model: "claude-opus-5-5",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });

  it("rethrows errors that are not API errors", async () => {
    const { sdk } = fakeSdk(() => Promise.reject(new TypeError("bug")));
    await expect(createAnthropicClient(sdk).complete(request)).rejects.toThrow("bug");
  });

  it("counts tokens with the same system prompt, messages and output config", async () => {
    const { sdk, counted } = fakeSdk(() => Promise.resolve(message()));
    expect(await createAnthropicClient(sdk).countTokens({ ...request, fallbacks: true })).toBe(1234);
    expect(counted[0]).toEqual({
      model: "claude-opus-5-5",
      system: toCreateParams(request).system,
      messages: toCreateParams(request).messages,
      output_config: toCreateParams(request).output_config,
    });
  });
});
