// Baseline: marks the start of the migration history and proves the setup works.
// It changes no schema on purpose: each table is created by the phase that uses it
// (P01 requirements.md, "First migration"). Migrations run in name order, so later files
// are numbered 0001_, 0002_, … and take the database as `up(db: Kysely<any>)`.

export function up(): Promise<void> {
  return Promise.resolve();
}

export function down(): Promise<void> {
  return Promise.resolve();
}
