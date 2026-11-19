// Shapes shared by the eval runner, the metrics and the reports (P04).

import type { LlmUsage } from "../../src/llm/client.js";
import type { ClassificationAttempt } from "../../src/pipeline/understand.js";

export interface JudgeScores {
  faithful: number;
  complete: number;
  contains_personal_data: boolean;
  reason: string;
}

export interface JudgeResult {
  outcome: "graded" | "invalid" | "error";
  scores: JudgeScores | null;
  rawOutput: string | null;
  errors: string[];
  promptVersion: string;
  model: string;
  usage: LlmUsage;
  costUsd: number | null;
  latencyMs: number;
}

/** One line of outputs.jsonl. Message text and labels stay in the dataset. */
export interface OutputLine {
  id: string;
  attempt: ClassificationAttempt;
  /** null when the classification was not valid, so there was no summary to grade. */
  judge: JudgeResult | null;
}
