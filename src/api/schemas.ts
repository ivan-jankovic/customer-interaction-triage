// JSON Schemas of the intake API (P02 requirements.md, "Data"). Fastify validates requests
// and serializes responses with them; types come from json-schema-to-ts via the type provider.

import { CHANNELS, LANGUAGES } from "../taxonomy.js";
import { INTERACTION_STATUSES } from "../db/database.js";

/** Longest accepted message; the longest dataset message has about 1,850 characters. */
export const MAX_TEXT_LENGTH = 20_000;
/** Covers MAX_TEXT_LENGTH even when every character is sent as a \uXXXX escape (6 bytes). */
export const BODY_LIMIT_BYTES = 256 * 1024;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export const createInteractionBody = {
  type: "object",
  properties: {
    external_id: { type: "string", minLength: 1, maxLength: 100 },
    channel: { type: "string", enum: CHANNELS },
    // null and absent both mean "unknown".
    language: { anyOf: [{ type: "string", enum: LANGUAGES }, { type: "null" }] },
    // At least one non-whitespace character. Ajv counts characters (code points), not bytes.
    text: { type: "string", minLength: 1, maxLength: MAX_TEXT_LENGTH, pattern: "\\S" },
    // ajv-formats' "date-time" requires a time zone (RFC 3339).
    received_at: { type: "string", format: "date-time" },
  },
  required: ["channel", "text"],
  additionalProperties: false,
} as const;

export const interactionParams = {
  type: "object",
  properties: { id: { type: "string", format: "uuid" } },
  required: ["id"],
  additionalProperties: false,
} as const;

export const listQuery = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
    before: { type: "string", format: "uuid" },
  },
  additionalProperties: false,
} as const;

export const interactionResponse = {
  type: "object",
  properties: {
    id: { type: "string" },
    external_id: { type: ["string", "null"] },
    channel: { type: "string", enum: CHANNELS },
    language: { type: ["string", "null"] },
    text: { type: "string" },
    received_at: { type: "string", format: "date-time" },
    status: { type: "string", enum: INTERACTION_STATUSES },
    created_at: { type: "string", format: "date-time" },
  },
  required: ["id", "external_id", "channel", "language", "text", "received_at", "status", "created_at"],
  additionalProperties: false,
} as const;

export const listResponse = {
  type: "object",
  properties: {
    items: { type: "array", items: interactionResponse },
    next_before: { type: ["string", "null"] },
  },
  required: ["items", "next_before"],
  additionalProperties: false,
} as const;

export const errorResponse = {
  type: "object",
  properties: {
    statusCode: { type: "integer" },
    error: { type: "string" },
    message: { type: "string" },
  },
  required: ["statusCode", "error", "message"],
} as const;
