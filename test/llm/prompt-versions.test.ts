// "Every prompt change gets a new version" (CLAUDE.md), enforced: each prompt file has a
// SHA-256 in src/llm/prompts/versions.json, so evaluation results that record a prompt
// version always point to the exact text that was used.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import { loadPrompt } from "../../src/llm/prompts.js";

const ROOT = join(import.meta.dirname, "../..");
const PROMPT_DIRS = ["src/llm/prompts", "eval/prompts"];
const registry = JSON.parse(readFileSync(join(ROOT, "src/llm/prompts/versions.json"), "utf8")) as {
  prompts: Record<string, { file: string; sha256: string }>;
};

const sha256 = (file: string) =>
  createHash("sha256")
    .update(readFileSync(join(ROOT, file)))
    .digest("hex");
const promptFiles = PROMPT_DIRS.flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `${dir}/${f}`),
);

/** Hashes as published in earlier phases; an entry here can never change. */
const PUBLISHED = {
  "classify.v1": "5cbe9e96e1f574927aad9a5f66d095be6ff6aab97367ee56a1f2b20e5ccbe4b6", // P03
  "summary-judge.v1": "84168ebd849a278d0d7f5d0f96ca5edfb52c0a4e6e66a662066a9a38e9d9d6ca", // P04; P05 keeps it unchanged
};

describe("prompt version registry", () => {
  it.each(Object.entries(PUBLISHED))("keeps %s's published hash", (version, hash) => {
    expect(registry.prompts[version]?.sha256).toBe(hash);
  });

  it("lists every prompt file under its version name", () => {
    for (const file of promptFiles) {
      const version = basename(file, ".md");
      expect(registry.prompts[version]?.file, `${file} is not in versions.json`).toBe(file);
    }
  });

  it.each(Object.entries(registry.prompts))("%s still has its published content", (version, entry) => {
    expect(existsSync(join(ROOT, entry.file)), `${entry.file} was removed; published prompts are kept`).toBe(true);
    expect(
      sha256(entry.file),
      `${version} changed after it was published. Add a new version (e.g. ${version.replace(/\d+$/, (n) => String(Number(n) + 1))}) instead of editing it.`,
    ).toBe(entry.sha256);
  });
});

describe.each(["classify.v1", "classify.v2"])("%s", (version) => {
  const raw = readFileSync(join(ROOT, `src/llm/prompts/${version}.md`), "utf8");
  const normalize = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
  const prompt = normalize(raw);

  it("has system and user sections with the channel and message placeholders", () => {
    const template = loadPrompt(version);
    expect(template.user).toContain("{{channel}}");
    expect(template.user).toMatch(/<customer_message>\n\{\{message\}\}\n<\/customer_message>/);
  });

  it("contains no dataset or injection message, not even a 40-character excerpt", () => {
    const records = [...readJsonl<{ text: string }>(PATHS.dataset), ...readJsonl<{ text: string }>(PATHS.injection)];
    expect(records.length).toBe(115);
    for (const { text } of records) {
      const t = normalize(text);
      for (let i = 0; i + 40 <= t.length; i += 10) {
        const excerpt = t.slice(i, i + 40);
        expect(prompt.includes(excerpt), `prompt contains dataset text: "${excerpt}"`).toBe(false);
      }
    }
  });
});
