// Compiled Ajv validators plus the rules a JSON Schema cannot express.

import { Ajv, type ErrorObject } from "ajv";
import { INTENT_TO_TEAM, ruleReviewReasons } from "../../src/taxonomy.js";
import { datasetRecordSchema, type DatasetRecord } from "./dataset-record.schema.js";
import { graderOutputSchema, labelsSchema, type GraderOutput, type Labels } from "./labels.schema.js";

const ajv = new Ajv({ allErrors: true, strict: true });

export const validateLabelsSchema = ajv.compile<Labels>(labelsSchema);
export const validateGraderOutputSchema = ajv.compile<GraderOutput>(graderOutputSchema);
export const validateRecordSchema = ajv.compile<DatasetRecord>(datasetRecordSchema);

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
}

/**
 * Cross-field rules for a label set:
 * - expected_team follows from the intent;
 * - cancellation/complaint review reasons are present exactly when the intent says so;
 * - must_review is true exactly when there is at least one review reason.
 */
export function labelRuleErrors(labels: Pick<Labels, "intent" | "must_review" | "review_reasons"> & { expected_team?: string }): string[] {
  const errors: string[] = [];
  if (labels.expected_team !== undefined && labels.expected_team !== INTENT_TO_TEAM[labels.intent]) {
    errors.push(`expected_team ${labels.expected_team} does not match intent ${labels.intent}`);
  }
  const ruleReasons = ruleReviewReasons(labels.intent);
  for (const reason of ruleReasons) {
    if (!labels.review_reasons.includes(reason)) errors.push(`intent ${labels.intent} requires review reason ${reason}`);
  }
  for (const reason of labels.review_reasons) {
    if (reason !== "unclear" && !ruleReasons.includes(reason)) {
      errors.push(`review reason ${reason} does not match intent ${labels.intent}`);
    }
  }
  if (labels.must_review !== labels.review_reasons.length > 0) {
    errors.push("must_review must be true exactly when review_reasons is non-empty");
  }
  return errors;
}

export function recordErrors(record: unknown): string[] {
  if (!validateRecordSchema(record)) return formatAjvErrors(validateRecordSchema.errors);
  const errors = labelRuleErrors(record.chosen).map((e) => `chosen: ${e}`);
  if (record.final) errors.push(...labelRuleErrors(record.final).map((e) => `final: ${e}`));
  if (record.id.startsWith("inj-") !== (record.attack !== undefined)) {
    errors.push("attack must be present exactly on injection records (inj-*)");
  }
  return errors;
}
