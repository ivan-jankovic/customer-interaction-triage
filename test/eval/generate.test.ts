import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Budget } from "../../eval/lib/cost.js";
import { deniedNamesIn } from "../../eval/lib/denylist.js";
import { PATHS } from "../../eval/lib/paths.js";
import { loadPrompt } from "../../src/llm/prompts.js";
import {
  GENERATE_PROMPT_VERSION,
  buildGenerationRequest,
  checkGenerated,
  generateOne,
  latestGenerated,
  rewriteFeedback,
  type GeneratedEntry,
} from "../../eval/dataset/generate.js";
import { buildPlan, type PlanEntry } from "../../eval/dataset/plan.js";
import { mockLlm } from "./mock-llm.js";

const prompt = loadPrompt(GENERATE_PROMPT_VERSION, PATHS.prompts);
const guide = readFileSync(PATHS.guide, "utf8");
const { dataset, injection } = buildPlan();
const withIds = dataset.find((e) => e.channel === "email" && e.chosen.fields.identifiers.length > 0)!;

function emailFor(entry: PlanEntry, extra = ""): string {
  const ids = entry.chosen.fields.identifiers.map((i) => i.value).join(", ");
  return JSON.stringify({ text: `Předmět: Dotaz\n\nDobrý den, píšu ohledně služby. Údaje: ${ids}. ${extra}` });
}

describe("generation prompt", () => {
  it("fills every placeholder and never leaks a raw {{var}}", () => {
    for (const entry of [...dataset, ...injection]) {
      const req = buildGenerationRequest(entry, prompt, guide, "claude-opus-5-5");
      expect(req.system + req.user).not.toMatch(/\{\{\w+\}\}/);
      for (const id of entry.chosen.fields.identifiers) expect(req.user).toContain(id.value);
    }
  });

  it("adds special instructions for ambiguous, mixed-language and injection entries", () => {
    const mixed = dataset.find((e) => e.secondary_intent)!;
    expect(buildGenerationRequest(mixed, prompt, guide, "m").user).toContain(
      `secondary concern of type ${mixed.secondary_intent}`,
    );
    const unclear = dataset.find((e) => e.chosen.review_reasons.includes("unclear"))!;
    expect(buildGenerationRequest(unclear, prompt, guide, "m").user).toContain("genuinely unclear");
    expect(buildGenerationRequest(injection[0]!, prompt, guide, "m").user).toContain("prompt-injection test message");
    expect(buildGenerationRequest(withIds, prompt, guide, "m", "Too formal.").user).toContain(
      "Their feedback: Too formal.",
    );
  });

  it("includes the full labelling guide in the system prompt", () => {
    expect(buildGenerationRequest(withIds, prompt, guide, "m").system).toContain("### Borderline cases");
  });
});

const messageText = (json: string): string => (JSON.parse(json) as { text: string }).text;

describe("checkGenerated", () => {
  it("accepts a message with every identifier verbatim", () => {
    expect(checkGenerated(messageText(emailFor(withIds)), withIds)).toEqual([]);
  });

  it("rejects a missing or reformatted identifier", () => {
    const id = withIds.chosen.fields.identifiers[0]!;
    const text = messageText(emailFor(withIds)).replace(id.value, id.value.replace(/\s/g, "-") + "x");
    expect(checkGenerated(text, withIds).join()).toContain("missing or altered");
  });

  it("rejects real operator names but not look-alike words", () => {
    expect(deniedNamesIn("Přecházím k Vodafonu? Ne, k Vodafone.")).toEqual(["Vodafone"]);
    expect(deniedNamesIn("Mám od O2 lepší nabídku")).toEqual(["O2"]);
    expect(deniedNamesIn("The router light is orange and telekomunikace are hard")).toEqual([]);
    expect(deniedNamesIn("Zdraví Juro, podá to dál")).toEqual([]);
  });

  it("checks the channel format", () => {
    const chat = {
      ...withIds,
      channel: "chat" as const,
      chosen: { ...withIds.chosen, fields: { ...withIds.chosen.fields, identifiers: [] } },
    };
    expect(checkGenerated("Dobrý den, nejde mi internet už od rána.", chat)).toContain(
      "chat/call is missing speaker labels",
    );
    expect(checkGenerated("Zákazník: Dobrý den, nejde mi internet.\nOperátor: Dobrý den.", chat)).toEqual([]);
  });
});

describe("generateOne", () => {
  const request = buildGenerationRequest(withIds, prompt, guide, "claude-opus-5-5");

  it("stores a valid response", async () => {
    const client = mockLlm(() => emailFor(withIds));
    const out = await generateOne(client, new Budget(10), withIds, request, 1);
    expect(out).toMatchObject({ id: withIds.id, ok: true, tries: 1, attempt: 1, prompt_version: "generate.v1" });
    expect(client.calls).toHaveLength(1);
  });

  it("retries with the problem fed back when an identifier is missing", async () => {
    const client = mockLlm((_, i) =>
      i === 0 ? JSON.stringify({ text: "Předmět: X\n\nDobrý den, nic tu není." }) : emailFor(withIds),
    );
    const out = await generateOne(client, new Budget(10), withIds, request, 1);
    expect(out.ok).toBe(true);
    expect(out.tries).toBe(2);
    expect(client.calls[1]!.user).toContain("rejected by an automatic check");
  });

  it("gives up after three tries and records the error", async () => {
    const client = mockLlm(() => ({ error: "refusal (null)" }));
    const out = await generateOne(client, new Budget(10), withIds, request, 2);
    expect(out).toMatchObject({ ok: false, tries: 3, attempt: 2, error: "refusal (null)", text: null });
    expect(client.calls).toHaveLength(3);
  });
});

describe("resume and rewrite helpers", () => {
  const row = (id: string, ok: boolean, attempt: number): GeneratedEntry => ({
    id,
    attempt,
    ok,
    text: ok ? "x" : null,
    error: ok ? null : "e",
    tries: 1,
    model: "m",
    prompt_version: "generate.v1",
    generated_at: "",
  });

  it("keeps the latest generation per id, so done ids are skipped on resume", () => {
    const latest = latestGenerated([row("msg-001", false, 1), row("msg-001", true, 1), row("msg-002", true, 1)]);
    expect(latest.get("msg-001")!.ok).toBe(true);
    expect(latest.size).toBe(2);
  });

  it("returns reviewer feedback only for ids whose latest decision is a rewrite", () => {
    const base = { attempt: 1, final: null, changed_fields: [], reviewed_at: "" };
    const fb = rewriteFeedback([
      { ...base, id: "msg-001", outcome: "rewrite_requested", note: "Too formal" },
      { ...base, id: "msg-002", outcome: "rewrite_requested", note: "x" },
      { ...base, id: "msg-002", outcome: "accepted", note: null },
    ]);
    expect([...fb]).toEqual([["msg-001", "Too formal"]]);
  });
});
