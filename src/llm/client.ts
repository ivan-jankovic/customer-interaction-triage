// Thin wrapper around the Anthropic SDK, shared by the pipeline (P03) and the dataset
// scripts (P00). The interface is small on purpose so tests can inject a mock: unit tests
// never call a model.
//
// - Structured output uses `output_config.format` (JSON Schema), not a forced tool call:
//   forced tool_choice returns a 400 on the current models.
// - Server-side refusal fallbacks are opt-in per request. The classifier turns them on, so a
//   safety decline doesn't send a case to review when another model can answer (P03
//   requirements.md). The P00 graders keep them off: grader independence depends on knowing
//   exactly which model answered. Requests always use the beta endpoint, which `fallbacks`
//   needs; without it, the request is the same as on the standard endpoint.
// - Checked against @anthropic-ai/sdk 1.10.0: `fallbacks` is a beta body parameter; whether a
//   fallback model served the response is shown by a `fallback_message` entry in
//   `usage.iterations` (P03 plan 1.1).

import Anthropic from "@anthropic-ai/sdk";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface LlmRequest {
  model: string;
  system: string;
  user: string;
  /** JSON Schema for structured output; omit for free text. */
  schema?: Record<string, unknown>;
  maxTokens: number;
  effort: Effort;
  /** Server-side refusal fallbacks (`fallbacks: "default"`). Off unless asked for. */
  fallbacks?: boolean;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Why a call produced no usable text. */
export type LlmFailure = "refusal" | "max_tokens" | "api_error";

export type LlmResult =
  | {
      ok: true;
      text: string;
      /** The model that served the response (the fallback model after a fallback). */
      model: string;
      usage: LlmUsage;
      fellBack?: boolean;
    }
  | {
      ok: false;
      error: string;
      model: string;
      usage: LlmUsage;
      fellBack?: boolean;
      failure?: LlmFailure;
      /**
       * For api_error only: the HTTP status, or null when there was none (a connection error or
       * timeout). The pipeline uses it to tell transient errors from permanent ones (P08).
       */
      status?: number | null;
      /** The model's text when there is some, e.g. a truncated answer at max_tokens. */
      text?: string;
    };

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResult>;
}

/** Free token counting (`messages.countTokens`), used by `classify --dry-run`. */
export interface TokenCounter {
  countTokens(request: LlmRequest): Promise<number>;
}

export const ZERO_USAGE: LlmUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const UNSUPPORTED_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

/**
 * Structured outputs reject string, number and complex array constraints. They are
 * removed from the schema sent to the API; callers still validate the full schema with
 * Ajv, so the constraints are enforced client-side.
 */
export function toApiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toApiSchema);
  if (schema === null || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !UNSUPPORTED_KEYWORDS.has(key))
      .map(([key, value]) => [key, key === "enum" || key === "const" ? value : toApiSchema(value)]),
  );
}

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** The request body for one call (exported for tests). */
export function toCreateParams(request: LlmRequest): CreateParams {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    // The system prompt is identical across calls, so it is cached; only the user turn varies.
    system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: request.user }],
    output_config: {
      effort: request.effort,
      ...(request.schema
        ? { format: { type: "json_schema", schema: toApiSchema(request.schema) as Record<string, unknown> } }
        : {}),
    },
    ...(request.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
  };
}

/** The part of the SDK the client uses, so tests can pass a fake. */
export interface MessagesApi {
  beta: {
    messages: {
      create(params: CreateParams): PromiseLike<Anthropic.Beta.Messages.BetaMessage>;
      countTokens(
        params: Anthropic.Beta.Messages.MessageCountTokensParams,
      ): PromiseLike<Anthropic.Beta.Messages.BetaMessageTokensCount>;
    };
  };
}

/** Converts one API response into an LlmResult (exported for tests). */
export function toResult(response: Anthropic.Beta.Messages.BetaMessage): LlmResult {
  const usage: LlmUsage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
  };
  const served = (response.usage.iterations ?? []).find((i) => i.type === "fallback_message");
  const model = served && "model" in served ? served.model : response.model;
  const fellBack = served !== undefined;
  const text = response.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? "no category";
    return { ok: false, error: `refusal (${category})`, failure: "refusal", model, usage, fellBack };
  }
  if (response.stop_reason === "max_tokens") {
    return { ok: false, error: "max_tokens reached", failure: "max_tokens", model, usage, fellBack, text };
  }
  return { ok: true, text, model, usage, fellBack };
}

export function createAnthropicClient(sdk: MessagesApi = new Anthropic({ maxRetries: 3 })): LlmClient & TokenCounter {
  return {
    async complete(request) {
      try {
        return toResult(await sdk.beta.messages.create(toCreateParams(request)));
      } catch (error) {
        // Non-retryable API errors (400, 401, 404) and exhausted retries end here.
        if (error instanceof Anthropic.APIError) {
          return {
            ok: false,
            error: `API error ${error.status ?? "?"}: ${error.message}`,
            failure: "api_error",
            status: typeof error.status === "number" ? error.status : null,
            model: request.model,
            usage: ZERO_USAGE,
          };
        }
        throw error;
      }
    },

    async countTokens(request) {
      const { model, system, messages, output_config } = toCreateParams(request);
      const result = await sdk.beta.messages.countTokens({ model, system, messages, output_config });
      return result.input_tokens;
    },
  };
}
