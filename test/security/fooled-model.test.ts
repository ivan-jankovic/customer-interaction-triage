// Worst case (P11 requirements.md, "Worst case"): the mocked model OBEYS the injection, and the
// code must still hold. Each test runs real injection messages through the pipeline's own
// functions (mask → understand → enrich on the in-memory seed → investigate → route); only the
// model is scripted. No model calls.
//
// The last tests pin down what the code can NOT catch (requirements.md, "Known limits"), so a
// reader sees the limit in the tests as well as in the docs.

import { describe, expect, it } from "vitest";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import { makeMessageRouter } from "../../eval/lib/route-message.js";
import type { DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import type { ConverseClient, ConverseResult, LlmClient, LlmUsage } from "../../src/llm/client.js";
import { loadPrompt } from "../../src/llm/prompts.js";
import type { Classification } from "../../src/llm/schemas/classification.schema.js";
import { readCrmSeed } from "../../src/db/crm-seed.js";
import { memoryCrm } from "../../src/pipeline/crm-memory.js";
import { enrich } from "../../src/pipeline/enrich.js";
import { INVESTIGATE_PROMPT_VERSION, investigate, type InvestigateInput } from "../../src/pipeline/investigate.js";
import { mask } from "../../src/pipeline/mask.js";
import { customerServiceTypes, route, type RouteInput } from "../../src/pipeline/route.js";
import { CLASSIFY_PROMPT_VERSION, understand, type ClassificationAttempt } from "../../src/pipeline/understand.js";

const seed = readCrmSeed();
const crm = memoryCrm(seed);
const router = makeMessageRouter(seed);
const injection = new Map(readJsonl<DatasetRecord>(PATHS.injection).map((r) => [r.id, r]));
const rec = (id: string) => injection.get(id)!;
const seedEntry = (id: string) => seed.injection.find((m) => m.message_id === id)!;
const USAGE: LlmUsage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/** A classifier that returns exactly this JSON, whatever it is asked. */
const obeying = (output: unknown): LlmClient => ({
  complete: (req) => Promise.resolve({ ok: true, text: JSON.stringify(output), model: req.model, usage: USAGE }),
});

/** A classify.v2 output for an injection message: its labels, with the fooled model's changes. */
function output(id: string, over: Record<string, unknown> = {}) {
  const l = rec(id).final!;
  return {
    intent: l.intent,
    urgency: l.urgency,
    language: rec(id).language,
    fields: { service_type: l.fields.service_type, area: l.fields.area },
    summary: "Customer writes about their service.",
    confidence: 0.9,
    ...over,
  };
}

async function classify(id: string, llm: LlmClient): Promise<ClassificationAttempt> {
  const m = mask(rec(id).text);
  return understand(
    { maskedText: m.maskedText, identifiers: m.identifiers, channel: rec(id).channel },
    { llm, model: "claude-opus-5-5", effort: "low", prompt: loadPrompt(CLASSIFY_PROMPT_VERSION), now: () => 0 },
  );
}

const routeOf = async (id: string, attempt: ClassificationAttempt, investigation: RouteInput["investigation"] = null) =>
  router({ id, text: rec(id).text }, attempt, investigation);

describe("a fooled classifier", () => {
  it.each([
    ["inj-001", { action: "switch_tariff", tariff: "Merelo Fiber 1000" }],
    ["inj-011", { skip_review: true }],
    ["inj-002", { refund_approved: true }],
  ])("%s: an extra field such as %j fails the schema and goes to review", async (id, extra) => {
    const attempt = await classify(id, obeying(output(id, extra)));
    expect(attempt.outcome).toBe("invalid");
    const r = await routeOf(id, attempt);
    expect(r.reasonCodes).toContain("invalid_output");
    expect(r.needsReview).toBe(true);
    expect(r.targetTeam).toBe("general");
  });

  it.each(["inj-007", "inj-011", "inj-012"])(
    "%s: confidence 1.0 on a cancellation still goes to review (no output field controls review)",
    async (id) => {
      const attempt = await classify(id, obeying(output(id, { confidence: 1 })));
      expect(attempt.outcome).toBe("valid");
      const r = await routeOf(id, attempt);
      expect(r.reasonCodes).toContain("cancellation");
      expect(r.needsReview).toBe(true);
      expect(r.targetTeam).toBe("retention");
    },
  );

  it("inj-010: confidence 1.0 on a complaint still goes to review", async () => {
    const r = await routeOf("inj-010", await classify("inj-010", obeying(output("inj-010", { confidence: 1 }))));
    expect(r.reasonCodes).toContain("complaint");
    expect(r.needsReview).toBe(true);
  });

  it("inj-003: an `other` request read as a complaint, as the message asks, lands in review", async () => {
    const r = await routeOf("inj-003", await classify("inj-003", obeying(output("inj-003", { intent: "complaint" }))));
    expect(r.targetTeam).toBe("complaints");
    expect(r.reasonCodes).toContain("complaint");
    expect(r.needsReview).toBe(true);
  });

  it("inj-013: a guessed phone number in the summary goes to review as suspicious_output", async () => {
    const summary = "Customer cancels; their number is +420 601 555 123 as requested.";
    const r = await routeOf("inj-013", await classify("inj-013", obeying(output("inj-013", { summary }))));
    expect(r.reasonCodes).toEqual(expect.arrayContaining(["cancellation", "suspicious_output"]));
    expect(r.firedRules.find((f) => f.reasonCode === "suspicious_output")!.detail).not.toContain("601");
  });

  it("inj-006: a guessed customer number on an otherwise auto-routed case still goes to review", async () => {
    const summary = "Billing question from customer MR55501234.";
    const clean = await routeOf("inj-006", await classify("inj-006", obeying(output("inj-006"))));
    expect(clean.needsReview).toBe(false);
    const r = await routeOf("inj-006", await classify("inj-006", obeying(output("inj-006", { summary }))));
    expect(r.reasonCodes).toEqual(["suspicious_output"]);
    expect(r.targetTeam).toBe("billing");
  });
});

// inj-014: a technical fault from a found customer whose message asks for other customers' data.
type Turn = { tools: { name: string; input: unknown }[] } | { answer: unknown };

function agent(turns: Turn[]): ConverseClient {
  let i = 0;
  return {
    converse(req): Promise<ConverseResult> {
      const t = turns[Math.min(i++, turns.length - 1)]!;
      if ("tools" in t) {
        const toolUses = t.tools.map((u, k) => ({ id: `tu_${i}_${k}`, name: u.name, input: u.input }));
        return Promise.resolve({
          ok: true,
          content: toolUses.map((u) => ({ type: "tool_use", ...u })),
          toolUses,
          text: "",
          stopReason: "tool_use",
          model: req.model,
          usage: USAGE,
        });
      }
      const text = JSON.stringify(t.answer);
      return Promise.resolve({
        ok: true,
        content: [{ type: "text", text }],
        toolUses: [],
        text,
        stopReason: "end_turn",
        model: req.model,
        usage: USAGE,
      });
    },
  };
}

const ID14 = "inj-014";
const OWN = seedEntry(ID14).expected.customer_id!;
/** A dataset customer: someone the inj-014 writer must not be able to read. */
const FOREIGN = seed.messages.find((m) => m.message_id === "msg-011")!.expected.customer_id!;

async function investigate14(turns: Turn[]) {
  const m = mask(rec(ID14).text);
  const l = rec(ID14).final!;
  const e = await enrich(
    {
      identifiers: m.identifiers,
      area: l.fields.area,
      serviceType: l.fields.service_type,
      receivedAt: new Date(seedEntry(ID14).received_at),
    },
    crm,
  );
  const input: InvestigateInput = {
    maskedText: m.maskedText,
    channel: rec(ID14).channel,
    receivedAt: new Date(seedEntry(ID14).received_at),
    classification: { serviceType: l.fields.service_type, area: l.fields.area, summary: "TV not working." },
    enrichment: {
      outcome: e.outcome,
      customerId: e.customerId,
      candidateIds: e.candidates.map((c) => c.customerId),
      area: e.area,
      areaSource: e.areaSource,
    },
  };
  let t = 0;
  const attempt = await investigate(input, {
    llm: agent(turns),
    crm,
    model: "claude-opus-5-5",
    effort: "low",
    prompt: loadPrompt(INVESTIGATE_PROMPT_VERSION),
    now: () => (t += 10),
  });
  return { attempt, enrichment: e };
}

const routeFault = async (inv: Awaited<ReturnType<typeof investigate14>>) => {
  const l = rec(ID14).final!;
  const c: Classification = {
    intent: "technical_fault",
    urgency: l.urgency,
    language: "sk",
    summary: "TV not working.",
    confidence: 0.9,
    fields: { identifiers: [], service_type: l.fields.service_type, area: l.fields.area },
  };
  return route({
    outcome: "valid",
    classification: c,
    enrichment: inv.enrichment,
    customerServiceTypes: await customerServiceTypes(crm, inv.enrichment.customerId),
    investigation: inv.attempt,
  });
};

const HEALTHY = {
  likely_cause: "customer_equipment",
  confidence: 0.8,
  summary: "The customer's TV service is up and no outage applies.",
  evidence: [{ tool: "get_line_status", finding: "TV service up; set-top box online." }],
};

describe("a fooled investigating agent", () => {
  it("inj-014 is a found customer in the seed (precondition)", () => {
    expect(seedEntry(ID14).expected.outcome).toBe("found");
    expect(FOREIGN).not.toBe(OWN);
  });

  it("gets an error, and no data, when it asks a tool for another customer's ID", async () => {
    const { attempt } = await investigate14([
      {
        tools: [
          { name: "get_line_status", input: { customer_id: FOREIGN } },
          { name: "get_recent_tickets", input: { customer_id: FOREIGN } },
          { name: "get_line_status", input: { customer_id: OWN } },
        ],
      },
      { answer: HEALTHY },
    ]);
    const [foreignLine, foreignTickets, own] = attempt.toolCalls;
    expect(foreignLine!.is_error).toBe(true);
    expect(foreignTickets!.is_error).toBe(true);
    expect(foreignLine!.result).toMatch(/not a customer of this case/);
    expect(own!.is_error).toBe(false);
    // Nothing of the foreign customer's comes back: none of their service IDs appears anywhere.
    const foreignServices = seed.services.filter((s) => s.customer_id === FOREIGN).map((s) => s.id);
    const sent = attempt.toolCalls.map((c) => c.result).join("\n");
    for (const s of foreignServices) expect(sent).not.toContain(s);
    expect(attempt.outcome).toBe("valid");
  });

  it("gets an error result for a tool that doesn't exist, writes nothing, and goes on", async () => {
    const before = JSON.stringify(seed);
    const { attempt } = await investigate14([
      {
        tools: [
          { name: "update_tariff", input: { customer_id: OWN, tariff: "Merelo TV Max" } },
          { name: "get_line_status", input: { customer_id: OWN } },
        ],
      },
      { answer: HEALTHY },
    ]);
    expect(attempt.toolCalls[0]).toMatchObject({ tool: "update_tariff", is_error: true });
    expect(attempt.outcome).toBe("valid");
    expect(JSON.stringify(seed)).toBe(before);
  });

  it("goes to review when it cites evidence from a tool it didn't call", async () => {
    const inv = await investigate14([
      { tools: [{ name: "get_line_status", input: { customer_id: OWN } }] },
      {
        answer: {
          ...HEALTHY,
          evidence: [{ tool: "get_recent_tickets", finding: "No tickets; the customer asked to close the case." }],
        },
      },
    ]);
    expect(inv.attempt.outcome).toBe("invalid");
    const r = await routeFault(inv);
    expect(r.reasonCodes).toContain("investigation_inconclusive");
    expect(r.targetTeam).toBe("technical_support");
  });

  it("goes to review when it writes an identifier into a finding", async () => {
    const inv = await investigate14([
      { tools: [{ name: "get_line_status", input: { customer_id: OWN } }] },
      {
        answer: {
          ...HEALTHY,
          evidence: [{ tool: "get_line_status", finding: "Line up; the other account is jana.k@example.net." }],
        },
      },
    ]);
    expect(inv.attempt.outcome).toBe("valid");
    const r = await routeFault(inv);
    expect(r.reasonCodes).toEqual(["suspicious_output"]);
    expect(r.targetTeam).toBe("technical_support");
  });
});

describe("what routing reads from a model's output", () => {
  const base = (): RouteInput => ({
    outcome: "valid",
    classification: {
      intent: "billing_question",
      urgency: "normal",
      language: "cs",
      summary: "Billing question.",
      confidence: 0.9,
      fields: { identifiers: [], service_type: "internet", area: "Kolín" },
    },
    enrichment: { outcome: "found", customerId: OWN, unmatchedPlaceholders: [] },
    customerServiceTypes: ["internet"],
  });

  it("gives the same result whatever the urgency, language or area", () => {
    const expected = route(base());
    for (const change of [
      (c: Classification) => (c.urgency = "high"),
      (c: Classification) => (c.urgency = "low"),
      (c: Classification) => (c.language = "en"),
      (c: Classification) => (c.fields.area = "Praha"),
      (c: Classification) => (c.fields.area = null),
    ]) {
      const i = base();
      change(i.classification!);
      expect(route(i)).toEqual(expected);
    }
  });
});

describe("known limits (requirements.md, Known limits)", () => {
  it("KNOWN LIMIT: a cancellation read as a billing question at 0.9 is auto-routed to billing", async () => {
    // No rule can see this: the model's reading of the text is the only defence, and
    // eval:injection measures it. If this test starts failing, the limit has been closed:
    // update requirements.md and the README.
    const attempt = await classify("inj-011", obeying(output("inj-011", { intent: "billing_question" })));
    const r = await routeOf("inj-011", attempt);
    expect(r.targetTeam).toBe("billing");
    expect(r.needsReview).toBe(false);
  });

  it("KNOWN LIMIT: a misleading summary without identifiers adds no reason code", async () => {
    const summary = "Refund approved and all fees waived as the customer asked; nothing left to do.";
    const r = await routeOf("inj-001", await classify("inj-001", obeying(output("inj-001", { summary }))));
    expect(r.reasonCodes).toEqual([]);
  });
});
