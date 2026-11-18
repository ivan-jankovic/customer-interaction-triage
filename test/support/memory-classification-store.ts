// In-memory ClassificationStore for unit tests, with the same behaviour as the Kysely store.

import type { ClassificationStore, StoredClassification } from "../../src/db/classifications.js";
import type { ClassificationAttempt } from "../../src/pipeline/understand.js";

export class MemoryClassificationStore implements ClassificationStore {
  readonly rows: StoredClassification[] = [];

  record(interactionId: string, attempt: ClassificationAttempt): Promise<StoredClassification> {
    const stored = {
      ...attempt,
      id: `00000000-0000-7000-9000-${(this.rows.length + 1).toString(16).padStart(12, "0")}`,
      interactionId,
      createdAt: new Date(),
    };
    this.rows.push(stored);
    return Promise.resolve(stored);
  }

  latestValid(interactionId: string): Promise<StoredClassification | undefined> {
    return this.listFor(interactionId).then((rows) => rows.find((r) => r.outcome === "valid"));
  }

  listFor(interactionId: string): Promise<StoredClassification[]> {
    return Promise.resolve(this.rows.filter((r) => r.interactionId === interactionId).reverse());
  }
}
