// The output check (P11 requirements.md, "Hardening"): looks for identifiers in what a model
// wrote. Every model call gets masked text only, and tool results hold no identifier values,
// so an identifier in a model's output was guessed, or copied from text the masker missed
// (for example after an injected instruction asked for it). Either way a person should look:
// route.v4 sends the case to review as `suspicious_output`.
//
// It reuses the masker's own rules (mask.v1), so "an identifier" means exactly what masking
// means by it. Placeholders such as [PHONE_1] are not identifiers, and Merelo's own
// merelo.example addresses aren't masked, so neither fires. Only types are returned, never
// values, so the result can go into the decision log.

import type { IdentifierType } from "../taxonomy.js";
import { mask } from "./mask.js";

export interface ModelOutputText {
  /** Which output, for the rule's detail, e.g. "classification summary" or "evidence 2". */
  output: string;
  text: string | null;
}

export interface OutputFinding {
  output: string;
  /** The identifier types found, in the order they appear, without repeats. */
  types: IdentifierType[];
}

/** One finding per output that holds at least one identifier; empty when all are clean. */
export function findIdentifiersInOutput(outputs: readonly ModelOutputText[]): OutputFinding[] {
  const findings: OutputFinding[] = [];
  for (const o of outputs) {
    if (!o.text) continue;
    const types = [...new Set(mask(o.text).identifiers.map((i) => i.type))];
    if (types.length > 0) findings.push({ output: o.output, types });
  }
  return findings;
}
