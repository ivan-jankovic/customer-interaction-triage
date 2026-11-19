// The enrichment step with storage (P06): reads the stored masking and the latest valid
// classification, runs the enrichment rules against the PostgreSQL CRM, and records one
// enrichments row per call (never updated; the latest row is the current enrichment).
// Free: no model is called, and nothing here reads raw_text.

import type { Kysely } from "kysely";
import { enrich, ENRICHER_VERSION, type EnrichmentResult } from "../pipeline/enrich.js";
import { KyselyClassificationStore } from "./classifications.js";
import { KyselyCrm } from "./crm.js";
import type { Database, EnrichmentRow } from "./database.js";
import { InteractionNotFound, readMasking } from "./masking.js";

/** Enrichment needs what earlier steps stored; this says which one is missing. */
export class NotReadyForEnrichment extends Error {}

export interface StoredEnrichment extends EnrichmentResult {
  id: string;
  interactionId: string;
  classificationId: string | null;
  enricherVersion: string;
  createdAt: Date;
}

export function toStoredEnrichment(row: EnrichmentRow): StoredEnrichment {
  return {
    id: row.id,
    interactionId: row.interaction_id,
    classificationId: row.classification_id,
    enricherVersion: row.enricher_version,
    createdAt: row.created_at,
    outcome: row.outcome,
    customerId: row.customer_id,
    candidates: row.candidates.map((c) => ({ customerId: c.customer_id, placeholders: c.placeholders })),
    unmatchedPlaceholders: row.unmatched_placeholders,
    area: row.area,
    areaSource: row.area_source,
    outageIds: row.outage_ids,
  };
}

export async function enrichInteraction(db: Kysely<Database>, interactionId: string): Promise<StoredEnrichment> {
  const interaction = await db
    .selectFrom("interactions")
    .select(["id", "received_at"])
    .where("id", "=", interactionId)
    .executeTakeFirst();
  if (!interaction) throw new InteractionNotFound(`No interaction ${interactionId}.`);

  const masking = await readMasking(db, interactionId);
  if (!masking) {
    throw new NotReadyForEnrichment(`Interaction ${interactionId} is not masked yet; classify it first.`);
  }
  const classification = await new KyselyClassificationStore(db).latestValid(interactionId);
  if (!classification?.classification) {
    throw new NotReadyForEnrichment(
      `Interaction ${interactionId} has no valid classification; enrichment needs its area and service type.`,
    );
  }

  const result = await enrich(
    {
      identifiers: masking.identifiers,
      area: classification.classification.fields.area,
      serviceType: classification.classification.fields.service_type,
      receivedAt: interaction.received_at,
    },
    new KyselyCrm(db),
  );

  const row = await db
    .insertInto("enrichments")
    .values({
      interaction_id: interactionId,
      classification_id: classification.id,
      enricher_version: ENRICHER_VERSION,
      outcome: result.outcome,
      customer_id: result.customerId,
      candidates: JSON.stringify(
        result.candidates.map((c) => ({ customer_id: c.customerId, placeholders: c.placeholders })),
      ),
      unmatched_placeholders: JSON.stringify(result.unmatchedPlaceholders),
      area: result.area,
      area_source: result.areaSource,
      outage_ids: JSON.stringify(result.outageIds),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toStoredEnrichment(row);
}

/** Every enrichment of an interaction, newest first. */
export async function listEnrichments(db: Kysely<Database>, interactionId: string): Promise<StoredEnrichment[]> {
  const rows = await db
    .selectFrom("enrichments")
    .selectAll()
    .where("interaction_id", "=", interactionId)
    .orderBy("id", "desc")
    .execute();
  return rows.map(toStoredEnrichment);
}
