import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Budget } from "../../eval/lib/cost.js";
import { toApiSchema } from "../../eval/lib/llm.js";
import { PATHS } from "../../eval/lib/paths.js";
import { loadPrompt } from "../../eval/lib/prompts.js";
import { GRADE_PROMPT_VERSION, buildGradeRequest, gradeOne, latestGraded } from "../../eval/dataset/grade.js";
import { agreementSample, findMismatch, normaliseArea } from "../../eval/dataset/mismatch.js";
import { graderOutputSchema, type GraderOutput } from "../../eval/schema/labels.schema.js";
import { labels } from "./fixtures.js";
import { mockLlm } from "./mock-llm.js";

const prompt = loadPrompt(GRADE_PROMPT_VERSION);
const guide = readFileSync(PATHS.guide, "utf8");

const answer = (o: Partial<GraderOutput> = {}): GraderOutput => ({
  intent: "technical_fault",
  urgency: "high",
  must_review: false,
  review_reasons: [],
  service_type: "internet",
  area: "Olomouc",
  rationale: "No internet since morning.",
  ...o,
});

describe("grade request", () => {
  const req = buildGradeRequest("Zákazník: Nejde internet.", "chat", prompt, guide, "claude-sonnet-5-5");

  it("contains the message and the guide but nothing about chosen labels", () => {
    expect(req.user).toContain("<message>\nZákazník: Nejde internet.\n</message>");
    expect(req.system).toContain("### Borderline cases");
    expect(req.system + req.user).not.toMatch(/\{\{\w+\}\}/);
    expect(req.user).not.toMatch(/intent:|urgency:|chosen/i);
  });

  it("sends a schema without keywords structured outputs reject, keeping enums intact", () => {
    const api = JSON.stringify(toApiSchema(graderOutputSchema));
    expect(api).not.toMatch(/minLength|uniqueItems|"pattern"/);
    expect(api).toContain('"enum":["billing_question"');
  });
});

describe("gradeOne", () => {
  const req = buildGradeRequest("text", "email", prompt, guide, "claude-haiku-5-5");

  it("stores a validated answer", async () => {
    const client = mockLlm(() => JSON.stringify(answer()));
    const out = await gradeOne(client, new Budget(1), "msg-001", 1, "b", req);
    expect(out).toMatchObject({ id: "msg-001", grader: "b", valid: true, prompt_version: "grade.v1", model: "claude-haiku-5-5" });
    expect(out.output).toEqual(answer());
  });

  it("retries once, then records an invalid answer", async () => {
    const client = mockLlm(() => JSON.stringify({ intent: "refund" }));
    const out = await gradeOne(client, new Budget(1), "msg-001", 1, "a", req);
    expect(client.calls).toHaveLength(2);
    expect(out).toMatchObject({ valid: false, output: null });
    expect(out.error).toMatch(/^schema:/);
  });

  it("accepts a valid answer on the retry", async () => {
    const client = mockLlm((_, i) => (i === 0 ? "not json" : JSON.stringify(answer())));
    expect((await gradeOne(client, new Budget(1), "msg-001", 1, "a", req)).valid).toBe(true);
  });

  it("keeps the latest grading per id, attempt and grader", () => {
    const base = { model: "m", prompt_version: "grade.v1", output: null, error: "e", graded_at: "" };
    const map = latestGraded([
      { ...base, id: "msg-001", attempt: 1, grader: "a", valid: false },
      { ...base, id: "msg-001", attempt: 1, grader: "a", valid: true },
      { ...base, id: "msg-001", attempt: 2, grader: "a", valid: false },
    ]);
    expect(map.get("msg-001#1#a")!.valid).toBe(true);
    expect(map.size).toBe(2);
  });
});

describe("mismatch", () => {
  it("needs no review when all three agree (area ignoring case and diacritics)", () => {
    const r = findMismatch(labels(), [answer(), answer({ area: "olomouc " })]);
    expect(r).toEqual({ needed: false, fields: [], invalidGrader: false });
    expect(normaliseArea("Žilina")).toBe(normaliseArea("zilina"));
  });

  it("lists the fields that differ", () => {
    const r = findMismatch(labels(), [answer({ urgency: "normal" }), answer({ area: null })]);
    expect(r.needed).toBe(true);
    expect(r.fields).toEqual(["urgency", "area"]);
  });

  it("sends a message with an invalid grader answer to review", () => {
    expect(findMismatch(labels(), [answer(), null])).toMatchObject({ needed: true, invalidGrader: true });
  });

  it("draws a deterministic sample of all-agree messages", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `msg-${String(i + 1).padStart(3, "0")}`);
    const agreeing = new Set(ids.filter((_, i) => i % 3 === 0));
    const a = agreementSample(ids, agreeing);
    expect(a).toEqual(agreementSample([...ids].reverse(), agreeing));
    expect(a.size).toBe(10);
    for (const id of a) expect(agreeing.has(id)).toBe(true);
  });
});
