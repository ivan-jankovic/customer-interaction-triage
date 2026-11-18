// What the understanding step's model call returns (P03 requirements.md, "Model output").
// Sent to the API as output_config.format (with length and range limits stripped, see
// toApiSchema) and validated in full with Ajv. No routing fields: must_review, review
// reasons and the team are decided in code (P07).

import type { FromSchema } from "json-schema-to-ts";
import { IDENTIFIER_TYPES, INTENTS, LANGUAGES, SERVICE_TYPES, URGENCY } from "../../taxonomy.js";

export const SUMMARY_MAX_LENGTH = 400;

export const classificationSchema = {
  type: "object",
  properties: {
    intent: { type: "string", enum: INTENTS },
    urgency: { type: "string", enum: URGENCY },
    language: { type: "string", enum: LANGUAGES },
    fields: {
      type: "object",
      properties: {
        identifiers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: IDENTIFIER_TYPES },
              value: { type: "string", minLength: 1 },
            },
            required: ["type", "value"],
            additionalProperties: false,
          },
        },
        service_type: { type: "string", enum: SERVICE_TYPES },
        area: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
      },
      required: ["identifiers", "service_type", "area"],
      additionalProperties: false,
    },
    summary: { type: "string", minLength: 1, maxLength: SUMMARY_MAX_LENGTH },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["intent", "urgency", "language", "fields", "summary", "confidence"],
  additionalProperties: false,
} as const;

export type Classification = FromSchema<typeof classificationSchema>;
