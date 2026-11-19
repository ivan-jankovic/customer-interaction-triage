// The investigating agent's three tools (P10 requirements.md, "Tools"). Read-only: they only
// call InvestigationCrm's reads, which in PostgreSQL run in a READ ONLY transaction
// (readOnlyCrm in src/db/crm.ts). Every problem (an unknown tool, input that fails its schema,
// a customer ID outside the case, a thrown error) becomes an error result for the model, never
// an exception, so the loop goes on and the call is recorded.
//
// Results hold no identifier values: services and customers appear by their UUIDs, never by
// customer number, contract number, phone or e-mail (the InvestigationCrm reads don't select
// them in the first place).

import { Ajv, type ValidateFunction } from "ajv";
import {
  checkOutagesInputSchema,
  getLineStatusInputSchema,
  getRecentTicketsInputSchema,
  type CheckOutagesInput,
  type CustomerToolInput,
} from "../llm/schemas/investigation.schema.js";
import { INVESTIGATE_TOOLS, type InvestigateTool } from "../taxonomy.js";
import type { InvestigationCrm } from "./investigation-crm.js";

/** check_outages also lists outages resolved this many days before the message. */
export const OUTAGES_RESOLVED_WITHIN_DAYS = 7;
/** get_recent_tickets looks back this far, and returns at most TICKETS_LIMIT. */
export const TICKETS_DAYS = 90;
export const TICKETS_LIMIT = 10;

export interface ToolContext {
  crm: InvestigationCrm;
  /** The message's received_at: the "now" of every tool. */
  receivedAt: Date;
  /**
   * The customers this case may look up: the found customer, or the ambiguous candidates.
   * Empty when the enrichment found none (then only check_outages can help).
   */
  customerIds: readonly string[];
}

export interface ToolResult {
  /** JSON text for a result, a plain sentence for an error. Sent to the model as is. */
  content: string;
  isError: boolean;
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validators: Record<InvestigateTool, ValidateFunction> = {
  check_outages: ajv.compile(checkOutagesInputSchema),
  get_line_status: ajv.compile(getLineStatusInputSchema),
  get_recent_tickets: ajv.compile(getRecentTicketsInputSchema),
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const error = (content: string): ToolResult => ({ content, isError: true });
const ok = (data: unknown): ToolResult => ({ content: JSON.stringify(data), isError: false });

export function isInvestigateTool(name: string): name is InvestigateTool {
  return (INVESTIGATE_TOOLS as readonly string[]).includes(name);
}

/** The customer-ID guard: a message must not be able to point the agent at someone else's data. */
function guard(ctx: ToolContext, customerId: string): ToolResult | null {
  if (ctx.customerIds.length === 0) {
    return error("This case has no identified customer, so customer tools can't be used. check_outages still can.");
  }
  if (!ctx.customerIds.includes(customerId)) {
    return error(`${customerId} is not a customer of this case. Allowed: ${ctx.customerIds.join(", ")}.`);
  }
  return null;
}

async function checkOutages(input: CheckOutagesInput, ctx: ToolContext): Promise<ToolResult> {
  const at = ctx.receivedAt;
  const outages = await ctx.crm.outagesInArea(input.area, input.service_type ?? null, at, OUTAGES_RESOLVED_WITHIN_DAYS);
  return ok({
    area: input.area,
    service_type: input.service_type ?? null,
    message_received_at: at.toISOString(),
    outages: outages.map((o) => ({
      id: o.id,
      area: o.area,
      service_type: o.serviceType,
      description: o.description,
      started_at: iso(o.startedAt),
      resolved_at: iso(o.resolvedAt),
      ongoing_when_message_received: o.resolvedAt === null || o.resolvedAt > at,
    })),
  });
}

async function getLineStatus(input: CustomerToolInput, ctx: ToolContext): Promise<ToolResult> {
  const refused = guard(ctx, input.customer_id);
  if (refused) return refused;
  const services = await ctx.crm.lineStatusOfCustomer(input.customer_id);
  return ok({
    customer_id: input.customer_id,
    services: services.map((s) => ({
      service_id: s.serviceId,
      service_type: s.serviceType,
      tariff: s.tariff,
      area: s.area,
      status: s.status,
      line_state: s.state,
      line_state_since: iso(s.stateSince),
      diagnostic: s.diagnostic,
    })),
  });
}

async function getRecentTickets(input: CustomerToolInput, ctx: ToolContext): Promise<ToolResult> {
  const refused = guard(ctx, input.customer_id);
  if (refused) return refused;
  const tickets = await ctx.crm.recentTickets(input.customer_id, ctx.receivedAt, TICKETS_DAYS, TICKETS_LIMIT);
  return ok({
    customer_id: input.customer_id,
    days: TICKETS_DAYS,
    tickets: tickets.map((t) => ({
      id: t.id,
      service_id: t.serviceId,
      category: t.category,
      summary: t.summary,
      opened_at: iso(t.openedAt),
      closed_at: iso(t.closedAt),
    })),
  });
}

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (!isInvestigateTool(name)) {
    return error(`Unknown tool "${name}". The tools are: ${INVESTIGATE_TOOLS.join(", ")}.`);
  }
  const validate = validators[name];
  if (!validate(input)) {
    const problems = (validate.errors ?? []).map((e) => `${e.instancePath || "input"} ${e.message ?? "is invalid"}`);
    return error(`Invalid input for ${name}: ${problems.join("; ")}.`);
  }
  try {
    switch (name) {
      case "check_outages":
        return await checkOutages(input as CheckOutagesInput, ctx);
      case "get_line_status":
        return await getLineStatus(input as CustomerToolInput, ctx);
      case "get_recent_tickets":
        return await getRecentTickets(input as CustomerToolInput, ctx);
    }
  } catch (e) {
    // The message is the driver's; it names no identifier values (the reads select none).
    return error(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
