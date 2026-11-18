// Thin wrapper around the Anthropic SDK for the dataset scripts. The interface is
// small on purpose so tests can inject a mock (unit tests never call a model).
//
// Structured output uses `output_config.format` (JSON Schema), not a forced tool call:
// forced tool_choice returns a 400 on claude-opus-5-5 and claude-sonnet-5-5.
// Server-side refusal fallbacks are deliberately NOT enabled: a fallback would swap the
// model silently, and grader independence depends on knowing exactly which model answered.
// A refusal is reported as an error result instead (generation retries; a grader refusal
// becomes an invalid output that goes to human review).

import Anthropic from "@anthropic-ai/sdk";

export type Effort = "low" | "medium" | "high";

export interface LlmRequest {
  model: string;
  system: string;
  user: string;
  /** JSON Schema for structured output; omit for free text. */
  schema?: Record<string, unknown>;
  maxTokens: number;
  effort: Effort;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export type LlmResult =
  | { ok: true; text: string; model: string; usage: LlmUsage }
  | { ok: false; error: string; model: string; usage: LlmUsage };

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResult>;
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

export function createAnthropicClient(): LlmClient {
  const client = new Anthropic({ maxRetries: 3 });
  return {
    async complete(request) {
      try {
        const response = await client.messages.create({
          model: request.model,
          max_tokens: request.maxTokens,
          // The system prompt (company context, labelling guide) is identical across calls,
          // so it is cached; only the per-message part varies.
          system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: request.user }],
          output_config: {
            effort: request.effort,
            ...(request.schema
              ? { format: { type: "json_schema", schema: toApiSchema(request.schema) as Record<string, unknown> } }
              : {}),
          },
        });
        const usage: LlmUsage = {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
        };
        if (response.stop_reason === "refusal") {
          return { ok: false, error: `refusal (${response.stop_details?.category ?? "no category"})`, model: response.model, usage };
        }
        if (response.stop_reason === "max_tokens") {
          return { ok: false, error: "max_tokens reached", model: response.model, usage };
        }
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        return { ok: true, text, model: response.model, usage };
      } catch (error) {
        // Non-retryable API errors (400, 401, 404) and exhausted retries end here.
        if (error instanceof Anthropic.APIError) {
          return { ok: false, error: `API error ${error.status ?? "?"}: ${error.message}`, model: request.model, usage: ZERO_USAGE };
        }
        throw error;
      }
    },
  };
}
