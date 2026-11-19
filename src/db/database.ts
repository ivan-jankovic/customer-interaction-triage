import { Kysely, PostgresDialect, type ColumnType, type Generated, type Selectable } from "kysely";
import pg from "pg";
import type { Classification } from "../llm/schemas/classification.schema.js";
import type { Channel, IdentifierType, Intent, Language, Urgency } from "../taxonomy.js";

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
  /** Set together by the masking step (P05), then never changed. */
  masked_text: ColumnType<string | null, never, string>;
  masker_version: ColumnType<string | null, never, string>;
  masked_at: ColumnType<Date | null, never, Date | string>;
}

export type InteractionRow = Selectable<InteractionsTable>;

/** Set on insert, never changed: classification rows are not updated. */
type Immutable<T> = ColumnType<T, T, never>;
/**
 * jsonb columns are written as JSON text: pg would turn a JS array into a PostgreSQL array
 * literal, not JSON. They are read back parsed.
 */
type Json<T> = ColumnType<T, string, never>;

/** Table `classifications` (migration 0002, P03 requirements.md). */
export interface ClassificationsTable {
  id: Generated<string>;
  interaction_id: Immutable<string>;
  outcome: Immutable<"valid" | "invalid" | "error">;
  intent: Immutable<Intent | null>;
  urgency: Immutable<Urgency | null>;
  language: Immutable<Language | null>;
  fields: ColumnType<Classification["fields"] | null, string | null, never>;
  summary: Immutable<string | null>;
  confidence: Immutable<number | null>;
  raw_output: Immutable<string | null>;
  errors: Json<string[]>;
  prompt_version: Immutable<string>;
  requested_model: Immutable<string>;
  served_model: Immutable<string>;
  fell_back: Immutable<boolean>;
  effort: Immutable<string>;
  input_tokens: Immutable<number>;
  output_tokens: Immutable<number>;
  cache_creation_input_tokens: Immutable<number>;
  cache_read_input_tokens: Immutable<number>;
  /** pg returns numeric as a string, to keep its precision. */
  cost_usd: ColumnType<string | null, number | null, never>;
  latency_ms: Immutable<number>;
  created_at: ColumnType<Date, never, never>;
}

export type ClassificationRow = Selectable<ClassificationsTable>;

/** Table `masked_identifiers` (migration 0003, P05): one row per placeholder. */
export interface MaskedIdentifiersTable {
  id: Generated<string>;
  interaction_id: Immutable<string>;
  placeholder: Immutable<string>;
  type: Immutable<IdentifierType>;
  value: Immutable<string>;
  normalized_value: Immutable<string>;
  start_offset: Immutable<number>;
  end_offset: Immutable<number>;
  created_at: ColumnType<Date, never, never>;
}

/** Table types for Kysely; each phase adds the tables it owns together with their migration. */
export interface Database {
  interactions: InteractionsTable;
  classifications: ClassificationsTable;
  masked_identifiers: MaskedIdentifiersTable;
}

export function createDb(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl }) }),
  });
}
