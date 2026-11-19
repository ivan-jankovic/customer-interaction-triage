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

// --- Multi-turn calls with tools (P10, the investigating agent) ---------------------------------

/** A tool the model may call; sent with `strict: true`, its schema stripped like output schemas. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown> | object;
}

/** Content the loop sends: text, or the results of the tools the model asked for. */
export type UserContent =
  { type: "text"; text: string } | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/**
 * A conversation message. Assistant content is passed back exactly as the API returned it
 * (`ConverseResult.content`): with thinking on, its blocks carry signatures the API checks.
 */
export type ConverseMessage =
  { role: "user"; content: string | UserContent[] } | { role: "assistant"; content: readonly unknown[] };

export interface ConverseRequest {
  model: string;
  system: string;
  messages: readonly ConverseMessage[];
  tools: readonly ToolDefinition[];
  /** The final answer's JSON Schema, sent as output_config.format together with the tools. */
  schema?: Record<string, unknown>;
  maxTokens: number;
  effort: Effort;
}

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export type ConverseResult =
  | {
      ok: true;
      /** The assistant content blocks as returned, to append to the conversation unchanged. */
      content: readonly unknown[];
      toolUses: ToolUse[];
      /** The text blocks joined: the final answer when the model stopped without tool calls. */
      text: string;
      stopReason: string | null;
      model: string;
      usage: LlmUsage;
    }
  | Extract<LlmResult, { ok: false }>;

/** The client's second method (P10): one turn of a conversation with tools. */
export interface ConverseClient {
  converse(request: ConverseRequest): Promise<ConverseResult>;
}

/** Free token counting (`messages.countTokens`), used by `classify --dry-run`. */
export interface TokenCounter {
  countTokens(request: LlmRequest): Promise<number>;
}

/** Free token counting for a conversation turn, used by `investigate --dry-run`. */
export interface ConverseTokenCounter {
  countConverseTokens(request: ConverseRequest): Promise<number>;
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

/**
 * The request body for one conversation turn (exported for tests). Strict tools, the answer
 * schema as output_config.format, the system prompt cached (with the tools before it, the
 * cache covers both), and no fallbacks: the stored model must be the one that used the tools.
 */
export function toConverseParams(request: ConverseRequest): CreateParams {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
    messages: request.messages as CreateParams["messages"],
    tools: request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toApiSchema(t.input_schema) as Anthropic.Beta.Messages.BetaTool.InputSchema,
      strict: true,
    })),
    output_config: {
      effort: request.effort,
      ...(request.schema
        ? { format: { type: "json_schema", schema: toApiSchema(request.schema) as Record<string, unknown> } }
        : {}),
    },
  };
}

/** Converts one conversation turn's response (exported for tests). */
export function toConverseResult(response: Anthropic.Beta.Messages.BetaMessage): ConverseResult {
  const base = toResult(response);
  if (!base.ok) return base;
  const toolUses = response.content
    .filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
  return {
    ok: true,
    content: response.content,
    toolUses,
    text: base.text,
    stopReason: response.stop_reason,
    model: base.model,
    usage: base.usage,
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

/** An API error as a result (non-retryable errors and exhausted retries); anything else rethrows. */
function apiErrorResult(error: unknown, model: string): Extract<LlmResult, { ok: false }> {
  if (error instanceof Anthropic.APIError) {
    return {
      ok: false,
      error: `API error ${error.status ?? "?"}: ${error.message}`,
      failure: "api_error",
      status: typeof error.status === "number" ? error.status : null,
      model,
      usage: ZERO_USAGE,
    };
  }
  throw error;
}

export function createAnthropicClient(
  sdk: MessagesApi = new Anthropic({ maxRetries: 3 }),
): LlmClient & TokenCounter & ConverseClient & ConverseTokenCounter {
  return {
    async complete(request) {
      try {
        return toResult(await sdk.beta.messages.create(toCreateParams(request)));
      } catch (error) {
        return apiErrorResult(error, request.model);
      }
    },

    async converse(request) {
      try {
        return toConverseResult(await sdk.beta.messages.create(toConverseParams(request)));
      } catch (error) {
        return apiErrorResult(error, request.model);
      }
    },

    async countConverseTokens(request) {
      const { model, system, messages, tools, output_config } = toConverseParams(request);
      const result = await sdk.beta.messages.countTokens({ model, system, messages, tools, output_config });
      return result.input_tokens;
    },

    async countTokens(request) {
      const { model, system, messages, output_config } = toCreateParams(request);
      const result = await sdk.beta.messages.countTokens({ model, system, messages, output_config });
      return result.input_tokens;
    },
  };
}
