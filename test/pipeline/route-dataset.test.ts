// Routing the kept classify.v2 run's 100 stored outputs (P07 validation.md, "Dataset-wide check"):
// free, no model, no database. A rule change that drops a review the labels ask for fails here.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import { makeMessageRouter, type MessageRoute } from "../../eval/lib/route-message.js";
import type { OutputLine } from "../../eval/metrics/types.js";
import type { DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import type { InvestigationSummary } from "../../src/pipeline/route.js";

const KEPT_RUN = join(PATHS.results, "kept", "20261119-010458-full-claude-opus-5-5-classify.v2");

const dataset = new Map(readJsonl<DatasetRecord>(PATHS.dataset).map((r) => [r.id, r]));
const outputs = readJsonl<OutputLine>(join(KEPT_RUN, "outputs.jsonl"));
const labelsOf = (id: string) => {
  const r = dataset.get(id)!;
  return r.final ?? r.chosen;
};

const routeAll = async (investigation: InvestigationSummary | null = null) => {
  const router = makeMessageRouter();
  const routes = new Map<string, MessageRoute>();
  for (const line of outputs) routes.set(line.id, await router(dataset.get(line.id)!, line.attempt, investigation));
  return routes;
};

describe("routing the kept classify.v2 outputs", () => {
  it("covers the whole dataset", () => {
    expect(outputs.map((o) => o.id).sort()).toEqual([...dataset.keys()].sort());
  });

  it("sends every must-review message to review, routes every team as labelled", async () => {
    const routes = await routeAll();
    const ids = [...routes.keys()];

    const missed = ids.filter((id) => labelsOf(id).must_review && !routes.get(id)!.needsReview);
    expect(missed, "must-review messages not sent to review").toEqual([]);

    const wrongTeam = ids.filter((id) => routes.get(id)!.targetTeam !== labelsOf(id).expected_team);
    expect(wrongTeam, "messages routed to another team than expected_team").toEqual([]);

    const unclearMissed = ids.filter(
      (id) =>
        labelsOf(id).review_reasons.includes("unclear") && !routes.get(id)!.reasonCodes.includes("low_confidence"),
    );
    expect(unclearMissed, "unclear messages without low_confidence").toEqual([]);

    // For the PR: the review rate and how often each code fires.
    const counts: Record<string, number> = {};
    for (const r of routes.values()) for (const code of r.reasonCodes) counts[code] = (counts[code] ?? 0) + 1;
    const reviewed = ids.filter((id) => routes.get(id)!.needsReview);
    const onlyReason = (code: string) =>
      reviewed.filter((id) => !labelsOf(id).must_review && routes.get(id)!.reasonCodes.join() === code);
    console.log(
      JSON.stringify(
        {
          reviewed: reviewed.length,
          labelledMustReview: ids.filter((id) => labelsOf(id).must_review).length,
          counts,
          unmatchedKey: onlyReason("crm_mismatch_unmatched_key"),
          unidentifiedOnly: onlyReason("customer_unidentified"),
          lowConfidenceOnly: onlyReason("low_confidence"),
          autoRouted: ids.filter(
            (id) => !routes.get(id)!.needsReview && routes.get(id)!.enrichment?.outcome === "found",
          ),
        },
        null,
        1,
      ),
    );
  });

  // P10 (route.v3): an investigation can only add a review, never remove one or change a team.
  it.each([
    ["every fault's investigation inconclusive", { outcome: "valid", likelyCause: "inconclusive", confidence: 0.9 }],
    ["every fault's investigation failed", { outcome: "error", likelyCause: null, confidence: null }],
    ["every fault's investigation conclusive", { outcome: "valid", likelyCause: "area_outage", confidence: 0.95 }],
  ] as const)("with %s, still reviews every must-review message and keeps every team", async (_, inv) => {
    const without = await routeAll();
    const routes = await routeAll(inv);
    for (const [id, r] of routes) {
      expect(r.targetTeam, id).toBe(without.get(id)!.targetTeam);
      for (const code of without.get(id)!.reasonCodes) expect(r.reasonCodes, id).toContain(code);
      if (labelsOf(id).must_review) expect(r.needsReview, id).toBe(true);
      // Classified as a technical fault: the only intent routed to technical_support.
      const fault = r.targetTeam === "technical_support";
      const added = r.reasonCodes.filter((c) => !without.get(id)!.reasonCodes.includes(c));
      expect(added, id).toEqual(fault && inv.likelyCause !== "area_outage" ? ["investigation_inconclusive"] : []);
    }
  });
});
