import { Kysely, PostgresDialect, type ColumnType, type Generated, type Selectable } from "kysely";
import pg from "pg";
import type { Channel, Language } from "../taxonomy.js";

/** Lifecycle of an interaction. Only `received` until the queue arrives in P08. */
export const INTERACTION_STATUSES = ["received"] as const;
export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];

// pg returns timestamptz as Date; inserts may pass a Date or an ISO string; nothing updates these.
type Timestamp = ColumnType<Date, Date | string | undefined, never>;

/** Table `interactions` (migration 0001, P02 requirements.md "Data"). */
export interface InteractionsTable {
  id: Generated<string>;
  external_id: string | null;
  channel: Channel;
  language: Language | null;
  raw_text: string;
  received_at: Timestamp;
  status: ColumnType<InteractionStatus, InteractionStatus | undefined, InteractionStatus>;
  created_at: Timestamp;
}

export type InteractionRow = Selectable<InteractionsTable>;

/** Table types for Kysely; each phase adds the tables it owns together with their migration. */
export interface Database {
  interactions: InteractionsTable;
}

export function createDb(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl }) }),
  });
}
