import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const evalDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = join(evalDir, "..");

// Intermediate files are committed: generation and grading cost money, so their
// outputs are kept for reproducibility and audit, not regenerated.
export const PATHS = {
  work: join(evalDir, "data", ".work"),
  plan: join(evalDir, "data", ".work", "plan.jsonl"),
  generated: join(evalDir, "data", ".work", "generated.jsonl"),
  graded: join(evalDir, "data", ".work", "graded.jsonl"),
  reviewLog: join(evalDir, "data", ".work", "review-log.jsonl"),
  runLog: join(evalDir, "data", ".work", "runs.jsonl"),
  dataset: join(evalDir, "data", "dataset.jsonl"),
  injection: join(evalDir, "data", "injection.jsonl"),
  dataReadme: join(evalDir, "data", "README.md"),
  guide: join(evalDir, "labelling-guide.md"),
  prompts: join(evalDir, "prompts"),
  results: join(evalDir, "results"),
  promptRegistry: join(evalDir, "..", "src", "llm", "prompts", "versions.json"),
} as const;
