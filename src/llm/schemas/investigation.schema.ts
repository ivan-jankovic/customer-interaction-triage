// The investigating agent's schemas (P10 requirements.md, "Tools" and "The loop"): the final
// answer, sent as output_config.format together with the tools (limits stripped by
// toApiSchema) and validated in full with Ajv, and the three tools' input schemas, sent as
// strict tools and validated with Ajv again before a tool runs.

import type { FromSchema } from "json-schema-to-ts";
import { INVESTIGATE_TOOLS, LIKELY_CAUSES, SERVICE_TYPES } from "../../taxonomy.js";

export const INVESTIGATION_SUMMARY_MAX_LENGTH = 400;
export const EVIDENCE_FINDING_MAX_LENGTH = 300;
export const EVIDENCE_MAX_ITEMS = 5;

export const investigationOutputSchema = {
  type: "object",
  properties: {
    likely_cause: { type: "string", enum: LIKELY_CAUSES },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string", minLength: 1, maxLength: INVESTIGATION_SUMMARY_MAX_LENGTH },
    evidence: {
      type: "array",
      maxItems: EVIDENCE_MAX_ITEMS,
      items: {
        type: "object",
        properties: {
          tool: { type: "string", enum: INVESTIGATE_TOOLS },
          finding: { type: "string", minLength: 1, maxLength: EVIDENCE_FINDING_MAX_LENGTH },
        },
        required: ["tool", "finding"],
        additionalProperties: false,
      },
    },
  },
  required: ["likely_cause", "confidence", "summary", "evidence"],
  additionalProperties: false,
} as const;

/**
 * The agent's final answer. A cause other than `inconclusive` needs at least one evidence item;
 * that, and "every evidence tool was called", are checked in code (src/pipeline/investigate.ts)
 * because a JSON Schema can't express them without if/then, which structured outputs reject.
 */
export type InvestigationOutput = FromSchema<typeof investigationOutputSchema>;
export type EvidenceItem = InvestigationOutput["evidence"][number];

/** Service types an outage can have (the classification's `unknown` is not one). */
const OUTAGE_SERVICE_TYPES = SERVICE_TYPES.filter((t) => t !== "unknown");

export const checkOutagesInputSchema = {
  type: "object",
  properties: {
    area: { type: "string", minLength: 1, maxLength: 100 },
    service_type: { type: "string", enum: OUTAGE_SERVICE_TYPES },
  },
  required: ["area"],
  additionalProperties: false,
} as const;

const customerInputSchema = {
  type: "object",
  properties: { customer_id: { type: "string", minLength: 1, maxLength: 100 } },
  required: ["customer_id"],
  additionalProperties: false,
} as const;

export const getLineStatusInputSchema = customerInputSchema;
export const getRecentTicketsInputSchema = customerInputSchema;

export type CheckOutagesInput = FromSchema<typeof checkOutagesInputSchema>;
export type CustomerToolInput = FromSchema<typeof customerInputSchema>;

/** The tool definitions sent to the API (strict), in INVESTIGATE_TOOLS order. */
export const TOOL_DEFINITIONS = [
  {
    name: "check_outages",
    description:
      "Known network outages in an area: those ongoing when the message arrived and those resolved in the 7 days before. Areas compare ignoring case and diacritics. Optionally only one service type.",
    input_schema: checkOutagesInputSchema,
  },
  {
    name: "get_line_status",
    description:
      "For each service of a customer of this case: service type, tariff, area, service status (active or terminated) and the line's state (up, degraded or down) with since when and a diagnostic note.",
    input_schema: getLineStatusInputSchema,
  },
  {
    name: "get_recent_tickets",
    description:
      "The customer's tickets opened in the 90 days before the message, newest first, at most 10: category, summary, opened and closed.",
    input_schema: getRecentTicketsInputSchema,
  },
] as const satisfies readonly { name: (typeof INVESTIGATE_TOOLS)[number]; description: string; input_schema: object }[];
