// In-memory InteractionStore for unit tests, with the same behaviour as KyselyInteractionStore:
// time-ordered ids, idempotency on external_id, newest first.

import {
  sameContent,
  type CreateResult,
  type Interaction,
  type InteractionStore,
  type ListOptions,
  type NewInteraction,
} from "../../src/db/interactions.js";

export class MemoryInteractionStore implements InteractionStore {
  readonly rows: Interaction[] = [];
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(input: NewInteraction): Promise<CreateResult> {
    const existing = input.external_id ? this.rows.find((r) => r.external_id === input.external_id) : undefined;
    if (existing) {
      return Promise.resolve(
        sameContent(existing, input) ? { kind: "existing", interaction: existing } : { kind: "conflict", existing },
      );
    }
    const now = this.now();
    const interaction: Interaction = {
      // A uuidv7-shaped id that sorts in insertion order, like the database's.
      id: `00000000-0000-7000-8000-${(++this.seq).toString(16).padStart(12, "0")}`,
      external_id: input.external_id,
      channel: input.channel,
      language: input.language,
      text: input.text,
      received_at: input.received_at ?? now,
      status: "received",
      created_at: now,
    };
    this.rows.push(interaction);
    return Promise.resolve({ kind: "created", interaction });
  }

  getById(id: string): Promise<Interaction | undefined> {
    return Promise.resolve(this.rows.find((r) => r.id === id));
  }

  list({ limit, before }: ListOptions): Promise<Interaction[]> {
    const sorted = [...this.rows].sort((a, b) => (a.id < b.id ? 1 : -1));
    return Promise.resolve(sorted.filter((r) => !before || r.id < before).slice(0, limit));
  }
}
