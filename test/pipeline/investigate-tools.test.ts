// The investigating agent's tools over the in-memory seed CRM (P10 validation.md, "Tools").

import { describe, expect, it } from "vitest";
import { readCrmSeed } from "../../src/db/crm-seed.js";
import { TOOL_DEFINITIONS } from "../../src/llm/schemas/investigation.schema.js";
import { memoryCrm } from "../../src/pipeline/crm-memory.js";
import { runTool, TICKETS_LIMIT, type ToolContext } from "../../src/pipeline/investigate-tools.js";
import type { InvestigationCrm } from "../../src/pipeline/investigation-crm.js";
import { INVESTIGATE_TOOLS } from "../../src/taxonomy.js";

const seed = readCrmSeed();
const crm = memoryCrm(seed);
const message = (id: string) => seed.messages.find((m) => m.message_id === id)!;
const json = (content: string) => JSON.parse(content) as Record<string, unknown>;

/** msg-011: a found customer with a mobile line in Opava, down during an ongoing outage. */
const m011 = message("msg-011");
const customer011 = m011.expected.customer_id!;
const ctx011: ToolContext = { crm, receivedAt: new Date(m011.received_at), customerIds: [customer011] };

/** msg-071: a found customer whose mobile line is down with no outage, and an open fault ticket. */
const m071 = message("msg-071");
const ctx071: ToolContext = {
  crm,
  receivedAt: new Date(m071.received_at),
  customerIds: [m071.expected.customer_id!],
};

describe("the tool set", () => {
  it("has exactly three tools, all of them reads", () => {
    expect([...INVESTIGATE_TOOLS]).toEqual(["check_outages", "get_line_status", "get_recent_tickets"]);
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([...INVESTIGATE_TOOLS]);
  });

  it("answers an unknown tool with an error result", async () => {
    const r = await runTool("reset_line", { customer_id: customer011 }, ctx011);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Unknown tool "reset_line"');
  });

  it.each([
    ["check_outages", {}],
    ["check_outages", { area: "Opava", service_type: "unknown" }],
    ["get_line_status", { customer: customer011 }],
    ["get_recent_tickets", "not an object"],
  ])("answers bad input for %s with an error result", async (tool, input) => {
    const r = await runTool(tool, input, ctx011);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^Invalid input for /);
  });

  it("turns a thrown error into an error result", async () => {
    const broken: InvestigationCrm = {
      ...crm,
      outagesInArea: () => Promise.reject(new Error("connection reset")),
    };
    const r = await runTool("check_outages", { area: "Opava" }, { ...ctx011, crm: broken });
    expect(r).toEqual({ content: "check_outages failed: connection reset", isError: true });
  });
});

describe("check_outages", () => {
  it("finds the ongoing outage of msg-011's service type in its area, ignoring case and diacritics", async () => {
    const r = await runTool("check_outages", { area: "OPAVA", service_type: "mobile" }, ctx011);
    expect(r.isError).toBe(false);
    const outages = json(r.content).outages as { id: string; ongoing_when_message_received: boolean }[];
    // Opava also had msg-021's outage, resolved earlier that week: listed, but not ongoing.
    expect(outages.filter((o) => o.ongoing_when_message_received).map((o) => o.id)).toEqual(m011.expected.outage_ids);
  });

  it("lists an outage resolved within 7 days as not ongoing (msg-021, Opava, resolved before it arrived)", async () => {
    const m = message("msg-021");
    const r = await runTool(
      "check_outages",
      { area: "Opava", service_type: "mobile" },
      { crm, receivedAt: new Date(m.received_at), customerIds: [] },
    );
    const outages = json(r.content).outages as { ongoing_when_message_received: boolean; resolved_at: string }[];
    expect(outages.length).toBeGreaterThan(0);
    expect(outages.every((o) => !o.ongoing_when_message_received && o.resolved_at < m.received_at)).toBe(true);
  });

  it("leaves out outages resolved more than 7 days before, and those not started yet", async () => {
    const o = seed.outages.find((x) => x.resolved_at !== null)!;
    const area = { area: o.area, service_type: o.service_type };
    const at = (ms: number) => ({ crm, receivedAt: new Date(ms), customerIds: [] });
    const ids = async (ms: number) =>
      (json((await runTool("check_outages", area, at(ms))).content).outages as { id: string }[]).map((x) => x.id);
    const resolved = Date.parse(o.resolved_at!);
    expect(await ids(resolved + 6 * 86_400_000)).toContain(o.id);
    expect(await ids(resolved + 8 * 86_400_000)).not.toContain(o.id);
    expect(await ids(Date.parse(o.started_at) - 60_000)).not.toContain(o.id);
  });
});

describe("get_line_status", () => {
  it("shows msg-071's mobile line down, by service ID, with no identifier values", async () => {
    const r = await runTool("get_line_status", { customer_id: m071.expected.customer_id }, ctx071);
    expect(r.isError).toBe(false);
    const services = json(r.content).services as Record<string, unknown>[];
    expect(services.find((s) => s.service_type === "mobile")).toMatchObject({ status: "active", line_state: "down" });
    expect(Object.keys(services[0]!).sort()).toEqual(
      ["area", "diagnostic", "line_state", "line_state_since", "service_id", "service_type", "status", "tariff"].sort(),
    );
  });

  it("refuses a customer ID that isn't the case's", async () => {
    const other = seed.customers.find((c) => c.id !== customer011)!.id;
    const r = await runTool("get_line_status", { customer_id: other }, ctx011);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("is not a customer of this case");
    expect(r.content).not.toContain("line_state");
  });

  it('answers "no customer" when the case has none', async () => {
    const r = await runTool("get_line_status", { customer_id: customer011 }, { ...ctx011, customerIds: [] });
    expect(r).toMatchObject({ isError: true });
    expect(r.content).toContain("no identified customer");
  });

  it("accepts each ambiguous candidate (msg-069: the old terminated service, the new holder's active one)", async () => {
    const m = message("msg-069");
    const holders = seed.services.filter((s) => s.service_type === "mobile" && s.phone !== null);
    // The two customers whose mobile service carries msg-069's moved number.
    const phoneKey = (p: string) => p.slice(-9);
    const counts = new Map<string, string[]>();
    for (const s of holders) counts.set(phoneKey(s.phone!), [...(counts.get(phoneKey(s.phone!)) ?? []), s.customer_id]);
    const candidates = [...counts.values()].find((ids) => ids.length === 2)!;
    const ctx = { crm, receivedAt: new Date(m.received_at), customerIds: candidates };
    const statuses = [];
    for (const id of candidates) {
      const r = await runTool("get_line_status", { customer_id: id }, ctx);
      expect(r.isError).toBe(false);
      statuses.push(...(json(r.content).services as { service_type: string; status: string }[]));
    }
    expect(
      statuses
        .filter((s) => s.service_type === "mobile")
        .map((s) => s.status)
        .sort(),
    ).toEqual(["active", "terminated"]);
  });
});

describe("get_recent_tickets", () => {
  it("returns msg-071's open fault ticket, newest first", async () => {
    const r = await runTool("get_recent_tickets", { customer_id: m071.expected.customer_id }, ctx071);
    const tickets = json(r.content).tickets as { category: string; closed_at: string | null; opened_at: string }[];
    expect(tickets[0]).toMatchObject({ category: "technical_fault", closed_at: null });
    expect(tickets.every((t) => t.opened_at <= m071.received_at)).toBe(true);
  });

  it("keeps to 90 days and at most 10 tickets", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const at = new Date("2026-11-04T12:00:00Z");
    const tickets = Array.from({ length: 14 }, (_, i) => ({
      id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
      customer_id: id,
      service_id: null,
      category: "other" as const,
      summary: `t${i}`,
      // Every 10 days back from the message: 0, 10, … 130 days.
      opened_at: new Date(at.getTime() - i * 10 * 86_400_000).toISOString(),
      closed_at: null,
    }));
    const small = memoryCrm({ customers: [], services: [], outages: [], tickets });
    const r = await runTool(
      "get_recent_tickets",
      { customer_id: id },
      { crm: small, receivedAt: at, customerIds: [id] },
    );
    const got = (json(r.content).tickets as { summary: string }[]).map((t) => t.summary);
    expect(got).toEqual(["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]);
    expect(got).toHaveLength(TICKETS_LIMIT);
  });
});

describe("no identifier values in any result", () => {
  const values = [
    ...seed.customers.flatMap((c) => [c.customer_number, c.email]),
    ...seed.services.flatMap((s) => [s.contract_number, s.phone]),
  ].filter((v): v is string => v !== null);

  it("for every customer's line status and tickets, and every outage area", async () => {
    const at = new Date("2026-11-06T18:00:00Z");
    const ctx = { crm, receivedAt: at, customerIds: seed.customers.map((c) => c.id) };
    const texts: string[] = [];
    for (const c of seed.customers) {
      texts.push((await runTool("get_line_status", { customer_id: c.id }, ctx)).content);
      texts.push((await runTool("get_recent_tickets", { customer_id: c.id }, ctx)).content);
    }
    for (const area of new Set(seed.outages.map((o) => o.area))) {
      texts.push((await runTool("check_outages", { area }, ctx)).content);
    }
    const all = texts.join("\n");
    for (const v of values) expect(all.includes(v), v).toBe(false);
  });
});
