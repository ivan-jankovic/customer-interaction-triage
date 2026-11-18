// Storage of interactions. The API depends on the InteractionStore interface, so its unit
// tests run with an in-memory store and no Docker (P02 requirements.md, "Store interface").

import type { Kysely } from "kysely";
import type { Channel, Language } from "../taxonomy.js";
import type { Database, InteractionRow, InteractionStatus } from "./database.js";

export interface NewInteraction {
  external_id: string | null;
  channel: Channel;
  language: Language | null;
  text: string;
  /** null = the time of intake. */
  received_at: Date | null;
}

export interface Interaction {
  id: string;
  external_id: string | null;
  channel: Channel;
  language: Language | null;
  text: string;
  received_at: Date;
  status: InteractionStatus;
  created_at: Date;
}

export type CreateResult =
  | { kind: "created"; interaction: Interaction }
  /** Same external_id and the same content: the earlier row, unchanged. */
  | { kind: "existing"; interaction: Interaction }
  /** Same external_id, different content: nothing is written. */
  | { kind: "conflict"; existing: Interaction };

export interface ListOptions {
  limit: number;
  /** Only interactions stored before this id (ids are time-ordered uuidv7). */
  before?: string | undefined;
}

export interface InteractionStore {
  create(input: NewInteraction): Promise<CreateResult>;
  getById(id: string): Promise<Interaction | undefined>;
  /** Newest stored first. */
  list(options: ListOptions): Promise<Interaction[]>;
}

/**
 * A repeat counts as the same message when channel, language and text match. received_at is
 * left out on purpose: when the caller omits it, it is the intake time, which differs on a retry.
 */
export function sameContent(existing: Interaction, input: NewInteraction): boolean {
  return existing.channel === input.channel && existing.language === input.language && existing.text === input.text;
}

export function toInteraction(row: InteractionRow): Interaction {
  return {
    id: row.id,
    external_id: row.external_id,
    channel: row.channel,
    language: row.language,
    text: row.raw_text,
    received_at: row.received_at,
    status: row.status,
    created_at: row.created_at,
  };
}

export class KyselyInteractionStore implements InteractionStore {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: NewInteraction): Promise<CreateResult> {
    // Insert first and look only on conflict: two requests with the same external_id at the
    // same time cannot both insert, and neither fails (no read-then-write race).
    const inserted = await this.db
      .insertInto("interactions")
      .values({
        external_id: input.external_id,
        channel: input.channel,
        language: input.language,
        raw_text: input.text,
        ...(input.received_at ? { received_at: input.received_at } : {}),
      })
      .onConflict((oc) => oc.column("external_id").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return { kind: "created", interaction: toInteraction(inserted) };

    // Only an external_id can conflict, so it is set here; rows are never deleted.
    const row = await this.db
      .selectFrom("interactions")
      .selectAll()
      .where("external_id", "=", input.external_id!)
      .executeTakeFirstOrThrow();
    const existing = toInteraction(row);
    return sameContent(existing, input) ? { kind: "existing", interaction: existing } : { kind: "conflict", existing };
  }

  async getById(id: string): Promise<Interaction | undefined> {
    const row = await this.db.selectFrom("interactions").selectAll().where("id", "=", id).executeTakeFirst();
    return row && toInteraction(row);
  }

  async list({ limit, before }: ListOptions): Promise<Interaction[]> {
    let query = this.db.selectFrom("interactions").selectAll().orderBy("id", "desc").limit(limit);
    if (before) query = query.where("id", "<", before);
    return (await query.execute()).map(toInteraction);
  }
}
