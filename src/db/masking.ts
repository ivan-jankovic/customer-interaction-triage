// The masking step (P05): masks an interaction once and stores the masked text and the
// mapping; every later call returns what was stored. Steps after this one (understanding,
// P06's lookup) read masked_text and masked_identifiers, never raw_text, when they call a model.

import type { Kysely } from "kysely";
import { mask, MASKER_VERSION, type MaskedIdentifier } from "../pipeline/mask.js";
import type { Database } from "./database.js";

export interface StoredMasking {
  maskedText: string;
  identifiers: MaskedIdentifier[];
  maskerVersion: string;
  maskedAt: Date;
  /** "now" when this call masked the interaction, "earlier" when it was already masked. */
  stored: "now" | "earlier";
}

export class InteractionNotFound extends Error {}

/** The stored masking, or null when the interaction isn't masked yet. Reads only. */
export async function readMasking(
  db: Kysely<Database>,
  interactionId: string,
): Promise<Omit<StoredMasking, "stored"> | null> {
  const row = await db
    .selectFrom("interactions")
    .select(["masked_text", "masker_version", "masked_at"])
    .where("id", "=", interactionId)
    .executeTakeFirst();
  if (!row) throw new InteractionNotFound(`No interaction ${interactionId}.`);
  if (row.masked_text === null) return null;
  const ids = await db
    .selectFrom("masked_identifiers")
    .selectAll()
    .where("interaction_id", "=", interactionId)
    .orderBy("start_offset")
    .execute();
  return {
    maskedText: row.masked_text,
    maskerVersion: row.masker_version!,
    maskedAt: row.masked_at!,
    identifiers: ids.map((i) => ({
      placeholder: i.placeholder,
      type: i.type,
      value: i.value,
      normalizedValue: i.normalized_value,
      start: i.start_offset,
      end: i.end_offset,
    })),
  };
}

export async function maskInteraction(db: Kysely<Database>, interactionId: string): Promise<StoredMasking> {
  const earlier = await readMasking(db, interactionId);
  if (earlier) return { ...earlier, stored: "earlier" };

  const row = await db
    .selectFrom("interactions")
    .select("raw_text")
    .where("id", "=", interactionId)
    .executeTakeFirstOrThrow();
  const result = mask(row.raw_text);

  // The update only applies while masked_text is still null, in the same transaction as the
  // mapping: when two calls race, one stores and the other finds nothing to update and reads.
  const won = await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("interactions")
      .set({ masked_text: result.maskedText, masker_version: MASKER_VERSION, masked_at: new Date() })
      .where("id", "=", interactionId)
      .where("masked_text", "is", null)
      .returning("masked_at")
      .executeTakeFirst();
    if (!updated) return false;
    if (result.identifiers.length > 0) {
      await trx
        .insertInto("masked_identifiers")
        .values(
          result.identifiers.map((i) => ({
            interaction_id: interactionId,
            placeholder: i.placeholder,
            type: i.type,
            value: i.value,
            normalized_value: i.normalizedValue,
            start_offset: i.start,
            end_offset: i.end,
          })),
        )
        .execute();
    }
    return true;
  });

  const stored = await readMasking(db, interactionId);
  return { ...stored!, stored: won ? "now" : "earlier" };
}
