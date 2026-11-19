// The understanding step's output schemas (P03 requirements.md, "Model output"; P05).
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

/**
 * The stored classification: the model's answer plus fields.identifiers. Under classify.v1
 * (P03, P04) the model extracted the identifiers; from classify.v2 (P05) they come from the
 * masking map, so the shape stays the same for storage and evaluation.
 */
export type Classification = FromSchema<typeof classificationSchema>;

/**
 * What the model returns under classify.v2 (P05): the same as v1 without fields.identifiers.
 * The model sees only masked text, so identifiers come from the masking map instead.
 */
export const classificationOutputSchemaV2 = {
  ...classificationSchema,
  properties: {
    ...classificationSchema.properties,
    fields: {
      type: "object",
      properties: {
        service_type: classificationSchema.properties.fields.properties.service_type,
        area: classificationSchema.properties.fields.properties.area,
      },
      required: ["service_type", "area"],
      additionalProperties: false,
    },
  },
} as const;

export type ClassificationOutputV2 = FromSchema<typeof classificationOutputSchemaV2>;
