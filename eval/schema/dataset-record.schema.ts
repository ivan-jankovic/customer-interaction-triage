// JSON Schema for one record in eval/data/dataset.jsonl and eval/data/injection.jsonl.

import type { FromSchema } from "json-schema-to-ts";
import { CHANNELS, LANGUAGES, REGISTERS } from "../../src/taxonomy.js";
import { graderOutputSchema, labelsSchema } from "./labels.schema.js";

export const INJECTION_TACTICS = [
  "direct_instruction",
  "fake_system_text",
  "hidden_in_quote",
  "review_bypass",
  "data_request",
] as const;
export type InjectionTactic = (typeof INJECTION_TACTICS)[number];

export const INJECTION_GOALS = ["reroute", "skip_review", "leak_data", "trigger_action"] as const;
export type InjectionGoal = (typeof INJECTION_GOALS)[number];

export const REVIEW_OUTCOMES = ["accepted", "corrected", "rewrite_requested"] as const;

const graderResultSchema = {
  type: "object",
  properties: {
    model: { type: "string", minLength: 1 },
    prompt_version: { type: "string", minLength: 1 },
    valid: { type: "boolean" },
    // null when the output stayed invalid after one retry.
    output: { anyOf: [graderOutputSchema, { type: "null" }] },
  },
  required: ["model", "prompt_version", "valid", "output"],
  additionalProperties: false,
} as const;

export const datasetRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string", pattern: "^(msg|inj)-\\d{3}$" },
    channel: { type: "string", enum: CHANNELS },
    language: { type: "string", enum: LANGUAGES },
    text: { type: "string", minLength: 20 },
    plan: {
      type: "object",
      properties: {
        register: { type: "string", enum: REGISTERS },
        designed_ambiguous: { type: "boolean" },
        mixed_language: { type: "boolean" },
        attempt: { type: "integer", minimum: 1 },
      },
      required: ["register", "designed_ambiguous", "mixed_language", "attempt"],
      additionalProperties: false,
    },
    chosen: labelsSchema,
    graders: { type: "array", items: graderResultSchema, maxItems: 2 },
    final: { anyOf: [labelsSchema, { type: "null" }] },
    review: {
      type: "object",
      properties: {
        needed: { type: "boolean" },
        sampled: { type: "boolean" },
        reviewed: { type: "boolean" },
        outcome: { anyOf: [{ type: "string", enum: REVIEW_OUTCOMES }, { type: "null" }] },
        changed_fields: { type: "array", items: { type: "string" } },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["needed", "sampled", "reviewed", "outcome", "changed_fields", "note"],
      additionalProperties: false,
    },
    generation: {
      type: "object",
      properties: {
        model: { type: "string", minLength: 1 },
        prompt_version: { type: "string", minLength: 1 },
      },
      required: ["model", "prompt_version"],
      additionalProperties: false,
    },
    attack: {
      type: "object",
      properties: {
        tactic: { type: "string", enum: INJECTION_TACTICS },
        goal: { type: "string", enum: INJECTION_GOALS },
      },
      required: ["tactic", "goal"],
      additionalProperties: false,
    },
  },
  required: ["id", "channel", "language", "text", "plan", "chosen", "graders", "final", "review", "generation"],
  additionalProperties: false,
} as const;

export type DatasetRecord = FromSchema<typeof datasetRecordSchema>;
