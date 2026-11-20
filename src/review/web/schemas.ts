// JSON Schemas of the review page's requests (P13). Query strings and form bodies arrive as
// text. The app's Ajv setup rejects unknown fields; a repeated form field arrives as an array
// and fails `type: "string"`. Filter selects send "" for "any", so the enums accept it.
// Length limits here are only a ceiling; the review rules (src/review/rules.ts) give the
// friendly per-field errors that the page shows next to the form.

import { REASON_CODES, TEAMS } from "../../taxonomy.js";
import { REVIEW_DECISIONS } from "../rules.js";

const anyOr = <T extends readonly string[]>(values: T) => ({ type: "string", enum: [...values, ""] }) as const;

const filterProps = {
  team: anyOr(TEAMS),
  reason: anyOr(REASON_CODES),
  spot_check: { type: "string", enum: ["1", ""] },
} as const;

export const NOTICES = ["confirmed", "corrected", "skipped"] as const;
export type NoticeName = (typeof NOTICES)[number];

export const caseParams = {
  type: "object",
  properties: { id: { type: "string", format: "uuid" } },
  required: ["id"],
  additionalProperties: false,
} as const;

export const queueQuery = {
  type: "object",
  properties: { ...filterProps, after: { type: "string", format: "uuid" } },
  additionalProperties: false,
} as const;

export const nextQuery = {
  type: "object",
  properties: { ...filterProps, done: { type: "string", enum: NOTICES } },
  additionalProperties: false,
} as const;

export const caseQuery = nextQuery;

export const reviewedQuery = {
  type: "object",
  properties: {
    reviewer: { type: "string", maxLength: 32, pattern: "^([a-z0-9][a-z0-9._-]{1,31})?$" },
    decision: anyOr(REVIEW_DECISIONS),
    before: { type: "string", format: "uuid" },
  },
  additionalProperties: false,
} as const;

/** A ceiling well above the rules' limits (note 1000, reason 500 characters). */
const text = { type: "string", maxLength: 5000 } as const;

export const loginBody = {
  type: "object",
  properties: { key: { type: "string", maxLength: 1000 }, reviewer: { type: "string", maxLength: 100 } },
  required: ["key", "reviewer"],
  additionalProperties: false,
} as const;

const formBase = { csrf: { type: "string", maxLength: 100 }, ...filterProps } as const;

export const logoutBody = {
  type: "object",
  properties: { csrf: formBase.csrf },
  additionalProperties: false,
} as const;

export const confirmBody = {
  type: "object",
  properties: { ...formBase, note: text },
  additionalProperties: false,
} as const;

export const correctBody = {
  type: "object",
  properties: { ...formBase, intent: text, new_team: text, note: text },
  additionalProperties: false,
} as const;

export const skipBody = {
  type: "object",
  properties: formBase,
  additionalProperties: false,
} as const;

export const unmaskBody = {
  type: "object",
  properties: { ...formBase, unmask_reason: text },
  additionalProperties: false,
} as const;
