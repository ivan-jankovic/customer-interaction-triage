// An in-memory CrmLookup built from the seed file (P06 plan.md, 1.3). The dataset-wide test
// enriches every message against it without a database; an integration test checks that the
// PostgreSQL implementation (src/db/crm.ts) gives the same answers.

import type { CrmSeed } from "../db/crm-seed.js";
import {
  lookupKey,
  normalizeArea,
  outageCovers,
  type CrmLookup,
  type CrmServiceType,
  type LookupKeyType,
  type ServiceSummary,
} from "./enrich.js";

import {
  daysBefore,
  outageRelevant,
  type InvestigationCrm,
  type LineStatusEntry,
  type OutageEntry,
} from "./investigation-crm.js";

type SeedLike = Pick<CrmSeed, "customers" | "services" | "outages"> & Partial<Pick<CrmSeed, "tickets" | "line_status">>;

const byStartThenId = (a: { started_at: string; id: string }, b: { started_at: string; id: string }) =>
  a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id);

/** Also implements the investigation reads (P10); tickets and line status are optional for P06's tests. */
export function memoryCrm(seed: SeedLike): CrmLookup & InvestigationCrm {
  const outageEntry = (o: CrmSeed["outages"][number]): OutageEntry => ({
    id: o.id,
    area: o.area,
    serviceType: o.service_type,
    description: o.description,
    startedAt: new Date(o.started_at),
    resolvedAt: o.resolved_at ? new Date(o.resolved_at) : null,
  });
  return {
    lineStatusOfCustomer: (customerId: string) =>
      Promise.resolve(
        seed.services
          .filter((s) => s.customer_id === customerId)
          .sort(byStartThenId)
          .map((s): LineStatusEntry => {
            const line = seed.line_status?.find((l) => l.service_id === s.id);
            return {
              serviceId: s.id,
              serviceType: s.service_type,
              tariff: s.tariff,
              area: s.area,
              status: s.status,
              state: line?.state ?? null,
              stateSince: line ? new Date(line.state_since) : null,
              diagnostic: line?.diagnostic ?? null,
            };
          }),
      ),
    recentTickets: (customerId: string, at: Date, days: number, limit: number) => {
      const from = daysBefore(at, days);
      return Promise.resolve(
        (seed.tickets ?? [])
          .filter((t) => t.customer_id === customerId)
          .map((t) => ({
            id: t.id,
            serviceId: t.service_id,
            category: t.category,
            summary: t.summary,
            openedAt: new Date(t.opened_at),
            closedAt: t.closed_at ? new Date(t.closed_at) : null,
          }))
          .filter((t) => t.openedAt >= from && t.openedAt <= at)
          .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime() || b.id.localeCompare(a.id))
          .slice(0, limit),
      );
    },
    outagesInArea: (area: string, serviceType: CrmServiceType | null, at: Date, resolvedWithinDays: number) =>
      Promise.resolve(
        seed.outages
          .filter((o) => normalizeArea(o.area) === normalizeArea(area))
          .filter((o) => serviceType === null || o.service_type === serviceType)
          .map(outageEntry)
          .filter((o) => outageRelevant(o, at, resolvedWithinDays))
          .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id)),
      ),
    customersByKey: (type: LookupKeyType, key: string) => {
      const matches = (value: string | null) => value !== null && lookupKey(type, value) === key;
      const ids =
        type === "customer_number"
          ? seed.customers.filter((c) => matches(c.customer_number)).map((c) => c.id)
          : type === "email"
            ? seed.customers.filter((c) => matches(c.email)).map((c) => c.id)
            : seed.services
                .filter((s) => matches(type === "phone" ? s.phone : s.contract_number))
                .map((s) => s.customer_id);
      return Promise.resolve([...new Set(ids)]);
    },
    servicesOfCustomer: (customerId: string) =>
      Promise.resolve(
        seed.services
          .filter((s) => s.customer_id === customerId)
          .map((s): ServiceSummary => ({ serviceType: s.service_type, area: s.area, status: s.status })),
      ),
    outagesAt: (area: string, serviceType: CrmServiceType | null, at: Date) =>
      Promise.resolve(
        seed.outages
          .filter(
            (o) =>
              normalizeArea(o.area) === normalizeArea(area) &&
              (serviceType === null || o.service_type === serviceType) &&
              outageCovers(
                { startedAt: new Date(o.started_at), resolvedAt: o.resolved_at ? new Date(o.resolved_at) : null },
                at,
              ),
          )
          .map((o) => o.id),
      ),
  };
}
