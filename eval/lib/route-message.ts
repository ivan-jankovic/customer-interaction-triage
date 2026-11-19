// Routes one dataset message from a stored classification attempt, without a database or a
// model (P07 requirements.md, "Evaluation"): mask the text (mask.v1), enrich against the
// in-memory seed CRM with the classified area and service type and the seed's received_at,
// then route (ROUTER_VERSION). Used by the eval scoring and by the dataset-wide routing test, so
// both see exactly what the pipeline would decide. The classify-only scoring passes no
// investigation (P10): those metrics then score as route.v2 did; the investigation eval
// passes the agent's attempt.

import { readCrmSeed, type CrmSeed } from "../../src/db/crm-seed.js";
import { memoryCrm } from "../../src/pipeline/crm-memory.js";
import { enrich, type EnrichmentResult } from "../../src/pipeline/enrich.js";
import { mask } from "../../src/pipeline/mask.js";
import { customerServiceTypes, route, type InvestigationSummary, type RouteResult } from "../../src/pipeline/route.js";
import type { ClassificationAttempt } from "../../src/pipeline/understand.js";

export interface MessageRoute extends RouteResult {
  /** null when the classification wasn't valid, so nothing was enriched. */
  enrichment: EnrichmentResult | null;
}

export type MessageRouter = (
  message: { id: string; text: string },
  attempt: Pick<ClassificationAttempt, "outcome" | "classification">,
  investigation?: InvestigationSummary | null,
) => Promise<MessageRoute>;

export function makeMessageRouter(seed: CrmSeed = readCrmSeed()): MessageRouter {
  const crm = memoryCrm(seed);
  const receivedAt = new Map(seed.messages.map((m) => [m.message_id, new Date(m.received_at)]));

  return async (message, attempt, investigation = null) => {
    const c = attempt.outcome === "valid" ? attempt.classification : null;
    if (!c) {
      return {
        ...route({ outcome: attempt.outcome, classification: null, enrichment: null, customerServiceTypes: [] }),
        enrichment: null,
      };
    }
    const at = receivedAt.get(message.id);
    if (!at) throw new Error(`${message.id} has no received_at in the CRM seed; run npm run crm:generate.`);
    const enrichment = await enrich(
      {
        identifiers: mask(message.text).identifiers,
        area: c.fields.area,
        serviceType: c.fields.service_type,
        receivedAt: at,
      },
      crm,
    );
    const result = route({
      outcome: "valid",
      classification: c,
      enrichment,
      customerServiceTypes: await customerServiceTypes(crm, enrichment.customerId),
      investigation,
    });
    return { ...result, enrichment };
  };
}
