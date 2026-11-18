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

describe("prompt version registry", () => {
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

describe("classify.v1", () => {
  const raw = readFileSync(join(ROOT, "src/llm/prompts/classify.v1.md"), "utf8");
  const normalize = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
  const prompt = normalize(raw);

  it("has system and user sections with the channel and message placeholders", () => {
    const template = loadPrompt("classify.v1");
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
