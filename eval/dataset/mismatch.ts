// Step 4 input: which messages need human review.
// A dataset message needs review when the chosen labels and both graders do not all
// agree on the compared fields, or when a grader's output was invalid. Identifiers are
// not compared: they are known exactly from the plan and checked in code.

import type { GraderOutput, Labels } from "../schema/labels.schema.js";
import { createRng } from "../lib/rng.js";

export const COMPARED_FIELDS = ["intent", "urgency", "must_review", "service_type", "area"] as const;
export type ComparedField = (typeof COMPARED_FIELDS)[number];

export const AGREEMENT_SAMPLE_SIZE = 10;
export const AGREEMENT_SAMPLE_SEED = 20261118;

export type Comparable = Record<ComparedField, string | boolean | null>;

export function normaliseArea(area: string | null): string | null {
  if (area === null) return null;
  const n = area.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
  return n === "" ? null : n;
}

export function fromLabels(l: Labels): Comparable {
  return {
    intent: l.intent,
    urgency: l.urgency,
    must_review: l.must_review,
    service_type: l.fields.service_type,
    area: normaliseArea(l.fields.area),
  };
}

export function fromGrader(g: GraderOutput): Comparable {
  return {
    intent: g.intent,
    urgency: g.urgency,
    must_review: g.must_review,
    service_type: g.service_type,
    area: normaliseArea(g.area),
  };
}

export interface MismatchResult {
  needed: boolean;
  /** Fields where the three label sets do not all agree. */
  fields: ComparedField[];
  invalidGrader: boolean;
}

/** `graders` holds each grader's output, or null when it was invalid. */
export function findMismatch(chosen: Labels, graders: readonly (GraderOutput | null)[]): MismatchResult {
  const invalidGrader = graders.length < 2 || graders.some((g) => g === null);
  const sets = [fromLabels(chosen), ...graders.filter((g): g is GraderOutput => g !== null).map(fromGrader)];
  const fields = COMPARED_FIELDS.filter((f) => sets.some((s) => s[f] !== sets[0]![f]));
  return { needed: invalidGrader || fields.length > 0, fields, invalidGrader };
}

/**
 * The fixed-seed sample of all-agree messages that is also reviewed by hand, to catch
 * mistakes the models share. Ids are shuffled once with the seed and the first
 * `size` agreeing ids are taken, so the sample only changes if agreement changes.
 */
export function agreementSample(
  allIds: readonly string[],
  agreeingIds: ReadonlySet<string>,
  size = AGREEMENT_SAMPLE_SIZE,
): Set<string> {
  const order = createRng(AGREEMENT_SAMPLE_SEED).shuffle([...allIds].sort());
  return new Set(order.filter((id) => agreeingIds.has(id)).slice(0, size));
}
