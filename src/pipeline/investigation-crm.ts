// What the investigating agent's tools read from the mock CRM (P10 requirements.md, "Tools").
// Kept apart from CrmLookup, which is enrichment's interface: the tools need more of the CRM
// (line status, tickets, outage details), and enrichment doesn't. Implemented over PostgreSQL
// (src/db/crm.ts, inside a read-only transaction) and in memory (src/pipeline/crm-memory.ts);
// an integration test checks they agree on the whole seed.

import type { Intent, LineState } from "../taxonomy.js";
import type { CrmServiceType, ServiceStatus } from "./enrich.js";

export interface LineStatusEntry {
  serviceId: string;
  serviceType: CrmServiceType;
  tariff: string;
  area: string;
  status: ServiceStatus;
  /** null when the service has no line-status row. */
  state: LineState | null;
  stateSince: Date | null;
  diagnostic: string | null;
}

export interface TicketEntry {
  id: string;
  serviceId: string | null;
  category: Intent;
  summary: string;
  openedAt: Date;
  closedAt: Date | null;
}

export interface OutageEntry {
  id: string;
  area: string;
  serviceType: CrmServiceType;
  description: string;
  startedAt: Date;
  resolvedAt: Date | null;
}

export interface InvestigationCrm {
  /** The customer's services with their line status, oldest service first. Empty for an unknown customer. */
  lineStatusOfCustomer(customerId: string): Promise<LineStatusEntry[]>;
  /** Tickets opened in [at − days, at], newest first, at most `limit`. */
  recentTickets(customerId: string, at: Date, days: number, limit: number): Promise<TicketEntry[]>;
  /**
   * Outages in `area` (compared with normalizeArea) of `serviceType` (any when null) that cover
   * `at`, or were resolved in (at − resolvedWithinDays, at]. Oldest first.
   */
  outagesInArea(
    area: string,
    serviceType: CrmServiceType | null,
    at: Date,
    resolvedWithinDays: number,
  ): Promise<OutageEntry[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The outage window rule shared by both implementations. */
export function outageRelevant(o: { startedAt: Date; resolvedAt: Date | null }, at: Date, resolvedWithinDays: number) {
  if (o.startedAt > at) return false;
  if (o.resolvedAt === null || o.resolvedAt > at) return true;
  return o.resolvedAt.getTime() > at.getTime() - resolvedWithinDays * DAY_MS;
}

export const daysBefore = (at: Date, days: number) => new Date(at.getTime() - days * DAY_MS);
