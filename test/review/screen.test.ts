// The review screen's layout (P09) from hand-built case views: no database.

import { describe, expect, it } from "vitest";
import { CUSTOMER, INVESTIGATION, T, view } from "../support/case-view.js";
import { intentMenu, pick, renderCase, teamMenu } from "../../src/review/screen.js";
import { INTENTS } from "../../src/taxonomy.js";

describe("renderCase", () => {
  it("shows the position, decision, reasons, classification, masked text, evidence and log", () => {
    const text = renderCase(view(), { index: 3, total: 41 }).join("\n");
    expect(text).toContain("Case 3 of 41  case-1");
    expect(text).toContain("Interaction int-1 (msg-008): email, cs, received 2026-11-17T07:30:00.000Z");
    expect(text).toContain("Team: billing    Review: needed");
    expect(text).toContain("  - crm_mismatch_unmatched_key: [EMAIL_1] matched no customer");
    expect(text).toContain(
      "Classification: intent billing_question (confidence 0.86), urgency normal, service internet, area Kolín",
    );
    expect(text).toContain("Summary: Customer asks why the invoice is higher.");
    expect(text).toContain("Message (masked):\n  Dobrý den,\n  volám z [PHONE_1], e-mail [EMAIL_1].");
    expect(text).toContain(`Customer ${CUSTOMER} (residential), matched by [PHONE_1]`);
    expect(text).toContain("internet, Fiber 300, Kolín, active");
    expect(text).toContain("Not in the CRM: [EMAIL_1]");
    expect(text).toContain("Outages: none when the message arrived");
    expect(text).toMatch(/1\. mask +\(mask\.v1\) placeholders: \[PHONE_1\]/);
    expect(text).not.toContain("Unmasked before");
  });

  it("marks a spot check and lists earlier unmaskings", () => {
    const v = view({ unmaskings: [{ reviewer: "reviewer-2", reason: "call back", unmaskedAt: T }] });
    v.case = { ...v.case, needsReview: false };
    const text = renderCase(v, { index: 1, total: 1 }).join("\n");
    expect(text).toContain("Review: not needed (auto-routed; spot check)");
    expect(text).toContain("Unmasked before:\n  reviewer-2 at 2026-11-17T07:30:00.000Z: call back");
  });

  it("shows ambiguous candidates", () => {
    const v = view({ customer: null });
    v.enrichment = {
      ...v.enrichment!,
      outcome: "ambiguous",
      customerId: null,
      candidates: [
        { customerId: "c-a", placeholders: ["[PHONE_1]"] },
        { customerId: "c-b", placeholders: ["[EMAIL_1]"] },
      ],
    };
    const text = renderCase(v, { index: 1, total: 1 }).join("\n");
    expect(text).toContain(
      "Customer lookup: ambiguous\n  Candidates:\n    customer c-a, matched by [PHONE_1]\n    customer c-b",
    );
  });

  it("says what is missing on a failure case", () => {
    const v = view({ classification: null, enrichment: null, customer: null });
    v.interaction = { ...v.interaction, maskedText: null };
    const text = renderCase(v, { index: 1, total: 1 }).join("\n");
    expect(text).toContain("Classification: none (processing failed before classifying)");
    expect(text).toContain("Message: not masked (processing failed at masking); [u]nmask shows the raw text.");
    expect(text).toContain("Customer lookup: not run");
  });

  it("shows an invalid classification's errors", () => {
    const v = view();
    v.classification = { ...v.classification!, outcome: "invalid", intent: null, errors: ["not valid JSON"] };
    expect(renderCase(v, { index: 1, total: 1 }).join("\n")).toContain(
      "Classification: invalid (classify.v2 / claude-opus-5-5): not valid JSON",
    );
  });
});

describe("menus", () => {
  it("numbers the intents and teams and marks current and default", () => {
    expect(intentMenu("billing_question")).toHaveLength(INTENTS.length);
    expect(intentMenu("billing_question")[0]).toBe("  1. billing_question  (current)");
    expect(teamMenu("billing", "retention")).toContain("  4. retention  (default)");
    expect(teamMenu("billing", "retention")[0]).toBe("  1. billing  (current)");
  });

  it("picks by number only", () => {
    expect(pick(INTENTS, " 4 ")).toBe("cancellation");
    expect(pick(INTENTS, "0")).toBeNull();
    expect(pick(INTENTS, "7")).toBeNull();
    expect(pick(INTENTS, "cancellation")).toBeNull();
  });
});

describe("renderCase: the investigation (P10)", () => {
  it("shows the cause, confidence, summary, evidence and every tool call with its input", () => {
    const text = renderCase(view({ investigation: INVESTIGATION }), { index: 1, total: 1 }).join("\n");
    expect(text).toContain(
      "Investigation: likely cause line_fault (confidence 0.85), 2 turns, claude-opus-5-5\n" +
        "  The customer's mobile line is down with no outage in Žilina.\n" +
        "  - [get_line_status] Mobile line down since 2026-11-04 18:00.\n" +
        "  - [check_outages] No outage in Žilina.\n" +
        "  Tools called:\n" +
        '    1. check_outages {"area":"Žilina","service_type":"mobile"}\n' +
        `    1. get_line_status {"customer_id":"${CUSTOMER}"}\n` +
        '    1. get_recent_tickets {"customer_id":"someone-else"}  (error)',
    );
  });

  it("shows a step limit with its error", () => {
    const inv = {
      ...INVESTIGATION,
      outcome: "step_limit",
      likelyCause: null,
      confidence: null,
      summary: null,
      evidence: [],
      steps: 6,
      errors: ["step limit: the model still asked for tools after 6 turns"],
    };
    const text = renderCase(view({ investigation: inv }), { index: 1, total: 1 }).join("\n");
    expect(text).toContain(
      "Investigation: step_limit, 6 turns, claude-opus-5-5: step limit: the model still asked for tools after 6 turns",
    );
    expect(text).not.toContain("likely cause");
  });

  it("says why a case wasn't investigated, and shows nothing for a case without the step", () => {
    const skipped = renderCase(
      view({ investigation: { skipped: "intent billing_question is not a technical fault" } }),
      {
        index: 1,
        total: 1,
      },
    ).join("\n");
    expect(skipped).toContain("Investigation: not run (intent billing_question is not a technical fault)");
    expect(renderCase(view(), { index: 1, total: 1 }).join("\n")).not.toContain("Investigation");
  });

  it("aligns the decision log's investigate step with the others", () => {
    const v = view();
    v.case = {
      ...v.case,
      log: [
        v.case.log[0]!,
        {
          seq: 2,
          step: "investigate",
          inputSummary: { investigation_id: "inv-1" },
          output: {
            outcome: "valid",
            likely_cause: "line_fault",
            confidence: 0.85,
            steps: 2,
            tools_called: ["get_line_status"],
          },
          ruleApplied: "investigate.v1 / claude-opus-5-5",
          createdAt: T,
        },
      ],
    };
    const lines = renderCase(v, { index: 1, total: 1 });
    expect(lines).toContain("  1. mask        (mask.v1) placeholders: [PHONE_1]");
    expect(lines).toContain(
      "  2. investigate (investigate.v1 / claude-opus-5-5) valid; cause line_fault, confidence 0.85, 2 turns, tools get_line_status",
    );
  });
});
