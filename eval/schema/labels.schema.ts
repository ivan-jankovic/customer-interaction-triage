// JSON Schemas for dataset labels. Enums come from src/taxonomy.ts so the schema and
// the code can never disagree. Subschemas are inlined (no $ref) so the same objects
// work for Ajv and for the API's structured outputs.

import type { FromSchema } from "json-schema-to-ts";
import {
  IDENTIFIER_TYPES,
  INTENTS,
  REVIEW_REASONS,
  SERVICE_TYPES,
  TEAMS,
  URGENCY,
} from "../../src/taxonomy.js";

export const identifierSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: IDENTIFIER_TYPES },
    value: { type: "string", minLength: 1 },
  },
  required: ["type", "value"],
  additionalProperties: false,
} as const;

const areaSchema = {
  anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
} as const;

export const labelsSchema = {
  type: "object",
  properties: {
    intent: { type: "string", enum: INTENTS },
    urgency: { type: "string", enum: URGENCY },
    must_review: { type: "boolean" },
    review_reasons: { type: "array", items: { type: "string", enum: REVIEW_REASONS }, uniqueItems: true },
    expected_team: { type: "string", enum: TEAMS },
    fields: {
      type: "object",
      properties: {
        identifiers: { type: "array", items: identifierSchema },
        service_type: { type: "string", enum: SERVICE_TYPES },
        area: areaSchema,
      },
      required: ["identifiers", "service_type", "area"],
      additionalProperties: false,
    },
  },
  required: ["intent", "urgency", "must_review", "review_reasons", "expected_team", "fields"],
  additionalProperties: false,
} as const;

export type Labels = FromSchema<typeof labelsSchema>;

/**
 * What a grader model returns. No identifiers (they are known exactly from the plan,
 * and code checks them) and no team (derived from the intent in code). The
 * rationale is shown to the human reviewer only.
 */
export const graderOutputSchema = {
  type: "object",
  properties: {
    intent: { type: "string", enum: INTENTS },
    urgency: { type: "string", enum: URGENCY },
    must_review: { type: "boolean" },
    review_reasons: { type: "array", items: { type: "string", enum: REVIEW_REASONS } },
    service_type: { type: "string", enum: SERVICE_TYPES },
    area: areaSchema,
    rationale: { type: "string" },
  },
  required: ["intent", "urgency", "must_review", "review_reasons", "service_type", "area", "rationale"],
  additionalProperties: false,
} as const;

export type GraderOutput = FromSchema<typeof graderOutputSchema>;
