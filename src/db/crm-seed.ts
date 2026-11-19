// The mock CRM seed file (P06 requirements.md, "Seed file"): eval/data/crm/seed.json, written by
// `npm run crm:generate` and loaded by `npm run crm:seed`. The schema lives in src/ (not eval/)
// because the app's seed command reads and validates it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import type { FromSchema } from "json-schema-to-ts";
import { INTENTS, LIKELY_CAUSES, LINE_STATES } from "../taxonomy.js";
import { AREA_SOURCES, CRM_SERVICE_TYPES, ENRICHMENT_OUTCOMES, SERVICE_STATUSES } from "../pipeline/enrich.js";

export const CRM_SEED_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "eval",
  "data",
  "crm",
  "seed.json",
);

export const CUSTOMER_SEGMENTS = ["residential", "business"] as const;

const uuid = { type: "string", format: "uuid" } as const;
const timestamp = { type: "string", format: "date-time" } as const;
const nullableUuid = { anyOf: [uuid, { type: "null" }] } as const;
const nullableTimestamp = { anyOf: [timestamp, { type: "null" }] } as const;

const seedMessageSchema = {
  type: "object",
  properties: {
    message_id: { type: "string" },
    received_at: timestamp,
    /** Why the generator set the message up this way, for readers of the seed. */
    design: { type: "string" },
    expected: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ENRICHMENT_OUTCOMES },
        customer_id: nullableUuid,
        area: { anyOf: [{ type: "string" }, { type: "null" }] },
        area_source: { anyOf: [{ type: "string", enum: AREA_SOURCES }, { type: "null" }] },
        outage_ids: { type: "array", items: uuid },
      },
      required: ["outcome", "customer_id", "area", "area_source", "outage_ids"],
      additionalProperties: false,
    },
    /** P10: the likely cause a technical fault is designed to have; null for other intents. */
    expected_cause: { anyOf: [{ type: "string", enum: LIKELY_CAUSES }, { type: "null" }] },
  },
  required: ["message_id", "received_at", "design", "expected", "expected_cause"],
  additionalProperties: false,
} as const;

export const crmSeedSchema = {
  type: "object",
  properties: {
    generator: { type: "string" },
    dataset_hash: { type: "string" },
    customers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: uuid,
          customer_number: { type: "string", pattern: "^MR\\d{8}$" },
          email: { anyOf: [{ type: "string", pattern: "^[^A-Z\\s]+@[^A-Z\\s]+$" }, { type: "null" }] },
          segment: { type: "string", enum: CUSTOMER_SEGMENTS },
          created_at: timestamp,
        },
        required: ["id", "customer_number", "email", "segment", "created_at"],
        additionalProperties: false,
      },
    },
    services: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: uuid,
          customer_id: uuid,
          service_type: { type: "string", enum: CRM_SERVICE_TYPES },
          tariff: { type: "string" },
          contract_number: { type: "string", pattern: "^SML-\\d{4}-\\d{5}$" },
          phone: { anyOf: [{ type: "string", pattern: "^\\+42[01]\\d{9}$" }, { type: "null" }] },
          area: { type: "string", minLength: 1 },
          status: { type: "string", enum: SERVICE_STATUSES },
          started_at: timestamp,
        },
        required: [
          "id",
          "customer_id",
          "service_type",
          "tariff",
          "contract_number",
          "phone",
          "area",
          "status",
          "started_at",
        ],
        additionalProperties: false,
      },
    },
    tickets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: uuid,
          customer_id: uuid,
          service_id: nullableUuid,
          category: { type: "string", enum: INTENTS },
          summary: { type: "string", minLength: 1 },
          opened_at: timestamp,
          closed_at: nullableTimestamp,
        },
        required: ["id", "customer_id", "service_id", "category", "summary", "opened_at", "closed_at"],
        additionalProperties: false,
      },
    },
    outages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: uuid,
          area: { type: "string", minLength: 1 },
          service_type: { type: "string", enum: CRM_SERVICE_TYPES },
          description: { type: "string", minLength: 1 },
          started_at: timestamp,
          resolved_at: nullableTimestamp,
        },
        required: ["id", "area", "service_type", "description", "started_at", "resolved_at"],
        additionalProperties: false,
      },
    },
    /** P10 (crm-generate.v2): one row per service. */
    line_status: {
      type: "array",
      items: {
        type: "object",
        properties: {
          service_id: uuid,
          state: { type: "string", enum: LINE_STATES },
          state_since: timestamp,
          diagnostic: { type: "string", minLength: 1 },
        },
        required: ["service_id", "state", "state_since", "diagnostic"],
        additionalProperties: false,
      },
    },
    messages: { type: "array", items: seedMessageSchema },
    /** P11 (crm-generate.v3): the injection set's messages, with no designed cause. */
    injection: { type: "array", items: seedMessageSchema },
  },
  required: [
    "generator",
    "dataset_hash",
    "customers",
    "services",
    "tickets",
    "outages",
    "line_status",
    "messages",
    "injection",
  ],
  additionalProperties: false,
} as const;

export type CrmSeed = FromSchema<typeof crmSeedSchema>;
export type SeedCustomer = CrmSeed["customers"][number];
export type SeedService = CrmSeed["services"][number];
export type SeedTicket = CrmSeed["tickets"][number];
export type SeedOutage = CrmSeed["outages"][number];
export type SeedLineStatus = CrmSeed["line_status"][number];
export type SeedMessage = CrmSeed["messages"][number];

// ajv-formats is CommonJS; under NodeNext its default import is the module object.
const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
export const validateCrmSeed = ajv.compile<CrmSeed>(crmSeedSchema);

/** Reads and validates the seed file; throws with the schema errors when it doesn't match. */
export function readCrmSeed(path = CRM_SEED_PATH): CrmSeed {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!validateCrmSeed(data)) {
    const errors = (validateCrmSeed.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
    throw new Error(`${path} does not match the seed schema:\n${errors.slice(0, 10).join("\n")}`);
  }
  return data;
}
