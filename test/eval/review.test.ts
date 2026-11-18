import { describe, expect, it } from "vitest";
import { assemble, reviewQueue, type WorkFiles } from "../../eval/dataset/assemble.js";
import { finalizeProblems } from "../../eval/dataset/finalize.js";
import type { GeneratedEntry } from "../../eval/dataset/generate.js";
import type { GradedEntry } from "../../eval/dataset/grade.js";
import { buildPlan, type PlanEntry } from "../../eval/dataset/plan.js";
import { changedFields, reviewLoop, type ReviewIo, type ReviewLogEntry } from "../../eval/dataset/review-state.js";
import type { GraderOutput } from "../../eval/schema/labels.schema.js";

const { dataset, injection } = buildPlan();

function gen(entry: PlanEntry, attempt = 1): GeneratedEntry {
  const ids = entry.chosen.fields.identifiers.map((i) => i.value).join(" ");
  return {
    id: entry.id,
    attempt,
    ok: true,
    text: `Předmět: Dotaz\n\nDobrý den, píšu kvůli službě. ${ids}`,
    error: null,
    tries: 1,
    model: "claude-opus-5-5",
    prompt_version: "generate.v1",
    generated_at: "",
  };
}

function agree(entry: PlanEntry): GraderOutput {
  const c = entry.chosen;
  return {
    intent: c.intent,
    urgency: c.urgency,
    must_review: c.must_review,
    review_reasons: c.review_reasons,
    service_type: c.fields.service_type,
    area: c.fields.area,
    rationale: "r",
  };
}

function graded(entry: PlanEntry, grader: "a" | "b", output: GraderOutput | null, attempt = 1): GradedEntry {
  return {
    id: entry.id,
    attempt,
    grader,
    model: grader === "a" ? "claude-sonnet-5-5" : "claude-haiku-5-5",
    prompt_version: "grade.v1",
    valid: output !== null,
    output,
    error: output ? null : "invalid",
    graded_at: "",
  };
}

/** 30 dataset entries where everything agrees, except entry 0 (urgency) and entry 1 (invalid grader B); plus 2 injection entries. */
function files(reviewLog: ReviewLogEntry[] = []): WorkFiles {
  const plan = [...dataset.slice(0, 30), ...injection.slice(0, 2)];
  const grades: GradedEntry[] = [];
  dataset.slice(0, 30).forEach((e, i) => {
    const flipped = e.chosen.urgency === "high" ? "low" : "high";
    grades.push(graded(e, "a", i === 0 ? { ...agree(e), urgency: flipped } : agree(e)));
    grades.push(graded(e, "b", i === 1 ? null : agree(e)));
  });
  return { plan, generated: plan.map((e) => gen(e)), graded: grades, reviewLog };
}

function scripted(answers: string[]): ReviewIo & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    ask: async () => {
      const next = answers.shift();
      if (next === undefined) throw new Error("script ran out of answers");
      return next;
    },
    print: (l) => printed.push(l),
  };
}

describe("assemble", () => {
  const assembly = assemble(files());
  const byId = new Map(assembly.records.map((a) => [a.record.id, a]));

  it("flags disagreements, invalid graders and every injection message for review", () => {
    expect(byId.get(dataset[0]!.id)!.record.review.needed).toBe(true);
    expect(byId.get(dataset[0]!.id)!.mismatchFields).toEqual(["urgency"]);
    expect(byId.get(dataset[1]!.id)!.invalidGrader).toBe(true);
    for (const inj of injection.slice(0, 2)) expect(byId.get(inj.id)!.record.review.needed).toBe(true);
  });

  it("samples exactly 10 all-agree messages and gives the rest their chosen labels as final", () => {
    const sampled = assembly.records.filter((a) => a.record.review.sampled);
    expect(sampled).toHaveLength(10);
    for (const a of sampled) expect(a.record.review.needed).toBe(false);
    const auto = assembly.records.filter((a) => !a.record.review.needed && !a.record.review.sampled);
    expect(auto).toHaveLength(18);
    for (const a of auto) expect(a.record.final).toEqual(a.record.chosen);
  });

  it("queues needed + sampled records: 2 mismatches + 10 sampled + 2 injections", () => {
    expect(reviewQueue(assembly)).toHaveLength(14);
  });

  it("blocks finalize until the queue is empty", () => {
    expect(finalizeProblems(assembly).some((p) => p.startsWith("waiting for review"))).toBe(true);
  });
});

describe("reviewLoop", () => {
  it("accepts, corrects, requests a rewrite, and stops on quit", async () => {
    const queue = reviewQueue(assemble(files()));
    const saved: ReviewLogEntry[] = [];
    const first = queue[0]!.record;
    const otherUrgency = first.chosen.urgency === "low" ? "normal" : "low";
    const io = scripted([
      "a", "", // accept chosen, no note
      "e", "", otherUrgency, "", "", "", "fixed urgency", // edit: only urgency changes
      "r", "Too formal for a chat.", // rewrite
      "q",
    ]);
    const made = await reviewLoop(queue, io, (e) => saved.push(e));
    expect(made).toBe(3);
    expect(saved[0]).toMatchObject({ id: queue[0]!.record.id, outcome: "accepted", changed_fields: [] });
    expect(saved[1]).toMatchObject({ id: queue[1]!.record.id, outcome: "corrected", note: "fixed urgency" });
    expect(saved[1]!.changed_fields).toContain("urgency");
    expect(saved[2]).toMatchObject({ id: queue[2]!.record.id, outcome: "rewrite_requested", final: null, note: "Too formal for a chat." });
  });

  it("resumes: decided records leave the queue, a rewrite waits for regeneration", async () => {
    const queue = reviewQueue(assemble(files()));
    const saved: ReviewLogEntry[] = [];
    await reviewLoop(queue, scripted(["a", "", "r", "redo", "q"]), (e) => saved.push(e));
    const after = assemble(files(saved));
    const queueAfter = reviewQueue(after);
    expect(queueAfter).toHaveLength(queue.length - 2);
    const rewritten = after.records.find((a) => a.record.id === saved[1]!.id)!;
    expect(rewritten.rewritePending).toBe(true);
    expect(finalizeProblems(after).some((p) => p.startsWith("waiting for rewrite"))).toBe(true);
  });

  it("re-queues a rewritten message once its new attempt is generated and graded", () => {
    const base = files();
    const target = dataset[5]!;
    const log: ReviewLogEntry[] = [
      { id: target.id, attempt: 1, outcome: "rewrite_requested", final: null, changed_fields: [], note: "x", reviewed_at: "" },
    ];
    const f: WorkFiles = {
      ...base,
      reviewLog: log,
      generated: [...base.generated, gen(target, 2)],
      graded: [...base.graded, graded(target, "a", agree(target), 2), graded(target, "b", { ...agree(target), area: "Jinde" }, 2)],
    };
    const a = assemble(f).records.find((r) => r.record.id === target.id)!;
    expect(a.rewritePending).toBe(false);
    expect(a.record.plan.attempt).toBe(2);
    expect(reviewQueue(assemble(f)).map((r) => r.record.id)).toContain(target.id);
  });

  it("does not let a grader with invalid output be taken", async () => {
    const queue = reviewQueue(assemble(files())).filter((a) => a.invalidGrader);
    const io = scripted(["2", "q"]);
    await reviewLoop(queue, io, () => {});
    expect(io.printed).toContain("  That grader has no valid answer.");
  });

  it("finalizes once every queued record is decided", async () => {
    const queue = reviewQueue(assemble(files()));
    const saved: ReviewLogEntry[] = [];
    await reviewLoop(queue, scripted(queue.flatMap(() => ["a", ""])), (e) => saved.push(e));
    expect(finalizeProblems(assemble(files(saved)))).toEqual([]);
  });

  it("reports changed fields", () => {
    const c = dataset[0]!.chosen;
    expect(changedFields(c, { ...c, fields: { ...c.fields, area: "Kolín" } })).toEqual(c.fields.area === "Kolín" ? [] : ["area"]);
  });
});
