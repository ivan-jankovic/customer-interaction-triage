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

type SeedLike = Pick<CrmSeed, "customers" | "services" | "outages">;

export function memoryCrm(seed: SeedLike): CrmLookup {
  return {
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
