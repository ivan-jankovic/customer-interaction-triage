import { describe, expect, it } from "vitest";
import { replaceStatsBlock, statsMarkdown } from "../../eval/dataset/stats.js";
import { labels, record } from "./fixtures.js";

const graderOut = {
  intent: "technical_fault" as const,
  urgency: "high" as const,
  must_review: false,
  review_reasons: [],
  service_type: "internet" as const,
  area: "Olomouc",
  rationale: "r",
};

const records = [
  record({
    id: "msg-001",
    final: labels(),
    graders: [
      { model: "claude-sonnet-5-5", prompt_version: "grade.v1", valid: true, output: graderOut },
      {
        model: "claude-haiku-5-5",
        prompt_version: "grade.v1",
        valid: true,
        output: { ...graderOut, urgency: "normal" },
      },
    ],
    review: { needed: true, sampled: false, reviewed: true, outcome: "accepted", changed_fields: [], note: null },
  }),
  record({
    id: "msg-002",
    language: "sk",
    final: labels({ urgency: "normal" }),
    graders: [
      { model: "claude-sonnet-5-5", prompt_version: "grade.v1", valid: false, output: null },
      {
        model: "claude-haiku-5-5",
        prompt_version: "grade.v1",
        valid: true,
        output: { ...graderOut, urgency: "normal" },
      },
    ],
    review: {
      needed: true,
      sampled: false,
      reviewed: true,
      outcome: "corrected",
      changed_fields: ["urgency"],
      note: null,
    },
  }),
];

describe("stats", () => {
  const md = statsMarkdown(records, [], []);

  it("counts intents per language with totals", () => {
    expect(md).toContain("| technical_fault | 1 | 1 | 0 | 2 |");
    expect(md).toContain("| **total** | 1 | 1 | 0 | 2 |");
  });

  it("reports review statistics and per-field changes", () => {
    expect(md).toContain("| reviewed by a person | 2 | 0 |");
    expect(md).toContain("| labels changed by the reviewer | 1 | 0 |");
    expect(md).toContain("| urgency | 1 |");
  });

  it("reports agreement with the final labels, counting invalid answers", () => {
    // Grader A: msg-001 matches fully, msg-002 invalid → 50% overall, 1 invalid.
    expect(md).toMatch(/\| grader A \(claude-sonnet-5-5\) \| 50% \| 50% \| 50% \| 50% \| 50% \| 50% \| 1 \|/);
    // Grader B: urgency normal matches msg-002 only.
    expect(md).toMatch(/\| grader B \(claude-haiku-5-5\) \| 100% \| 50% \|/);
  });

  it("is deterministic and replaces only the marked block", () => {
    expect(statsMarkdown(records, [], [])).toBe(md);
    const readme = "intro\n<!-- stats:start -->\nold\n<!-- stats:end -->\noutro";
    const once = replaceStatsBlock(readme, md);
    expect(replaceStatsBlock(once, md)).toBe(once);
    expect(once.startsWith("intro\n")).toBe(true);
    expect(once.endsWith("<!-- stats:end -->\noutro")).toBe(true);
  });
});
