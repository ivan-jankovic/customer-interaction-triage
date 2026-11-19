// The investigating agent's output and tool schemas (P10), validated with Ajv as the loop does.

import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { toApiSchema } from "../../src/llm/client.js";
import {
  checkOutagesInputSchema,
  getLineStatusInputSchema,
  investigationOutputSchema,
  TOOL_DEFINITIONS,
} from "../../src/llm/schemas/investigation.schema.js";
import { INVESTIGATE_TOOLS } from "../../src/taxonomy.js";

const ajv = new Ajv({ allErrors: true, strict: true });
const validOutput = ajv.compile(investigationOutputSchema);

/** The example in requirements.md (The loop). */
const EXAMPLE = {
  likely_cause: "area_outage",
  confidence: 0.9,
  summary:
    "An ongoing mobile outage in Opava covers the time of the message; the customer's mobile line is down since then.",
  evidence: [
    { tool: "check_outages", finding: "Outage <id> (mobile, Opava) started 2026-11-06 07:47, not resolved." },
    { tool: "get_line_status", finding: "Service <id> (mobile) down since 2026-11-06 07:50." },
  ],
};

describe("investigationOutputSchema", () => {
  it("accepts the example from the spec", () => {
    expect(validOutput(EXAMPLE), JSON.stringify(validOutput.errors)).toBe(true);
  });

  it("accepts inconclusive with no evidence", () => {
    expect(validOutput({ ...EXAMPLE, likely_cause: "inconclusive", evidence: [] })).toBe(true);
  });

  it.each([
    ["a cause outside the list", { likely_cause: "router_on_fire" }],
    ["a confidence above 1", { confidence: 1.2 }],
    ["a confidence below 0", { confidence: -0.1 }],
    ["an empty summary", { summary: "" }],
    ["a summary over 400 characters", { summary: "x".repeat(401) }],
    ["six evidence items", { evidence: Array.from({ length: 6 }, () => EXAMPLE.evidence[0]) }],
    ["evidence from an unknown tool", { evidence: [{ tool: "reset_line", finding: "done" }] }],
    ["a finding over 300 characters", { evidence: [{ tool: "check_outages", finding: "x".repeat(301) }] }],
    ["an extra property", { team: "general" }],
  ])("rejects %s", (_, change) => {
    expect(validOutput({ ...EXAMPLE, ...change })).toBe(false);
  });
});

describe("tool input schemas", () => {
  const outages = ajv.compile(checkOutagesInputSchema);
  const line = ajv.compile(getLineStatusInputSchema);

  it("accept an area with or without a service type, and a customer ID", () => {
    expect(outages({ area: "Opava" })).toBe(true);
    expect(outages({ area: "Opava", service_type: "mobile" })).toBe(true);
    expect(line({ customer_id: "89ee7ed0-e07e-4b00-93e2-e973c3e885a0" })).toBe(true);
  });

  it("reject a missing area, the service type unknown, extra properties and a missing customer ID", () => {
    expect(outages({})).toBe(false);
    expect(outages({ area: "Opava", service_type: "unknown" })).toBe(false);
    expect(outages({ area: "Opava", customer_id: "x" })).toBe(false);
    expect(line({})).toBe(false);
  });

  it("define exactly the three tools, in order, and survive the API schema stripping", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([...INVESTIGATE_TOOLS]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(JSON.stringify(toApiSchema(tool.input_schema))).not.toMatch(/minLength|maxLength/);
    }
  });
});
