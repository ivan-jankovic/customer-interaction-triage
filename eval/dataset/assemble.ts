// Joins the work files (plan, generations, gradings, review log) into dataset records
// with their review state. Used by the review CLI, finalize and stats, so all three
// see the same view of the data.

import { INTENT_TO_TEAM, ruleReviewReasons, type ReviewReason } from "../../src/taxonomy.js";
import type { DatasetRecord } from "../schema/dataset-record.schema.js";
import type { GraderOutput, Labels } from "../schema/labels.schema.js";
import { readJsonl } from "../lib/jsonl.js";
import { PATHS } from "../lib/paths.js";
import { latestGenerated, type GeneratedEntry } from "./generate.js";
import { latestGraded, type GradedEntry, type GraderSlot } from "./grade.js";
import { agreementSample, findMismatch, type ComparedField } from "./mismatch.js";
import type { PlanEntry } from "./plan.js";
import type { ReviewLogEntry } from "./review-state.js";

export interface WorkFiles {
  plan: PlanEntry[];
  generated: GeneratedEntry[];
  graded: GradedEntry[];
  reviewLog: ReviewLogEntry[];
}

export function readWorkFiles(): WorkFiles {
  return {
    plan: readJsonl<PlanEntry>(PATHS.plan),
    generated: readJsonl<GeneratedEntry>(PATHS.generated),
    graded: readJsonl<GradedEntry>(PATHS.graded),
    reviewLog: readJsonl<ReviewLogEntry>(PATHS.reviewLog),
  };
}

export interface AssembledRecord {
  record: DatasetRecord;
  /** Fields where chosen and graders disagree (empty for injection records). */
  mismatchFields: ComparedField[];
  invalidGrader: boolean;
  /** Both graders answered for the current attempt (always true for injection records). */
  fullyGraded: boolean;
  /** The latest decision for the current attempt asked for a rewrite that has not happened yet. */
  rewritePending: boolean;
}

export interface Assembly {
  records: AssembledRecord[];
  /** Plan ids with no successful generation yet. */
  notGenerated: string[];
}

const SLOTS: GraderSlot[] = ["a", "b"];

/** Grader output turned into full labels: identifiers come from the plan, the team and rule-based reasons from code. */
export function labelsFromGrader(g: GraderOutput, chosen: Labels): Labels {
  return normaliseLabels({
    intent: g.intent,
    urgency: g.urgency,
    must_review: g.must_review,
    review_reasons: g.review_reasons,
    expected_team: INTENT_TO_TEAM[g.intent],
    fields: { identifiers: chosen.fields.identifiers, service_type: g.service_type, area: g.area },
  });
}

/**
 * Makes labels consistent with the rules: the team follows the intent, rule-based review
 * reasons follow the intent, "unclear" is kept if given, and must_review follows the reasons.
 */
export function normaliseLabels(l: Labels): Labels {
  const reasons: ReviewReason[] = [...ruleReviewReasons(l.intent)];
  if (l.review_reasons.includes("unclear")) reasons.push("unclear");
  return { ...l, expected_team: INTENT_TO_TEAM[l.intent], review_reasons: reasons, must_review: reasons.length > 0 };
}

export function assemble(files: WorkFiles): Assembly {
  const generated = latestGenerated(files.generated);
  const graded = latestGraded(files.graded);
  const reviews = new Map<string, ReviewLogEntry>();
  for (const e of files.reviewLog) reviews.set(e.id, e);

  const records: AssembledRecord[] = [];
  const notGenerated: string[] = [];
  for (const entry of files.plan) {
    const gen = generated.get(entry.id);
    if (!gen?.ok || gen.text === null) {
      notGenerated.push(entry.id);
      continue;
    }
    const isInjection = entry.id.startsWith("inj-");
    const gradings = isInjection ? [] : SLOTS.map((s) => graded.get(`${entry.id}#${gen.attempt}#${s}`));
    const fullyGraded = gradings.every((g) => g !== undefined);
    const mismatch = isInjection
      ? { needed: true, fields: [] as ComparedField[], invalidGrader: false }
      : findMismatch(
          entry.chosen,
          gradings.map((g) => (g?.valid ? g.output : null)),
        );

    const review = reviews.get(entry.id);
    const current = review && review.attempt === gen.attempt ? review : undefined;
    const reviewed = current !== undefined && current.outcome !== "rewrite_requested";

    records.push({
      record: {
        id: entry.id,
        channel: entry.channel,
        language: entry.language,
        text: gen.text,
        plan: {
          register: entry.register,
          designed_ambiguous: entry.designed_ambiguous,
          mixed_language: entry.mixed_language,
          attempt: gen.attempt,
        },
        chosen: entry.chosen,
        graders: gradings
          .filter((g): g is GradedEntry => g !== undefined)
          .map((g) => ({ model: g.model, prompt_version: g.prompt_version, valid: g.valid, output: g.output })),
        final: null, // set below, once the agreement sample is known
        review: {
          needed: mismatch.needed,
          sampled: false,
          reviewed,
          outcome: current?.outcome ?? null,
          changed_fields: current?.changed_fields ?? [],
          note: current?.note ?? null,
        },
        generation: { model: gen.model, prompt_version: gen.prompt_version },
        ...(entry.attack ? { attack: entry.attack } : {}),
      },
      mismatchFields: mismatch.fields,
      invalidGrader: mismatch.invalidGrader,
      fullyGraded: isInjection || fullyGraded,
      rewritePending: current?.outcome === "rewrite_requested",
    });
  }

  // The agreement sample is drawn over fully graded dataset messages where all three agree.
  const datasetIds = files.plan.filter((e) => e.id.startsWith("msg-")).map((e) => e.id);
  const agreeing = new Set(
    records
      .filter((r) => r.record.id.startsWith("msg-") && r.fullyGraded && !r.record.review.needed)
      .map((r) => r.record.id),
  );
  const sample = agreementSample(datasetIds, agreeing);

  for (const a of records) {
    const r = a.record;
    r.review.sampled = sample.has(r.id);
    const current = reviews.get(r.id);
    if (r.review.reviewed && current?.final) r.final = current.final;
    else if (a.fullyGraded && !r.review.needed && !r.review.sampled) r.final = r.chosen;
  }
  return { records, notGenerated };
}

/** Records still waiting for a human decision. */
export function reviewQueue(assembly: Assembly): AssembledRecord[] {
  return assembly.records.filter(
    (a) =>
      a.fullyGraded &&
      !a.rewritePending &&
      !a.record.review.reviewed &&
      (a.record.review.needed || a.record.review.sampled),
  );
}
