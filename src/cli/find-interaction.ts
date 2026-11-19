import type { Kysely } from "kysely";
import type { Database, InteractionRow } from "../db/database.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Finds an interaction by its uuid or its external_id (e.g. msg-001). */
export async function findInteraction(db: Kysely<Database>, ref: string): Promise<InteractionRow | undefined> {
  const query = db.selectFrom("interactions").selectAll();
  return UUID.test(ref)
    ? query.where("id", "=", ref).executeTakeFirst()
    : query.where("external_id", "=", ref).executeTakeFirst();
}
