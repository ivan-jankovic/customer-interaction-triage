import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "./paths.js";

export interface PromptTemplate {
  version: string;
  system: string;
  user: string;
}

/** Loads eval/prompts/<version>.md and splits it on the === system === / === user === markers. */
export function loadPrompt(version: string, dir: string = PATHS.prompts): PromptTemplate {
  const raw = readFileSync(join(dir, `${version}.md`), "utf8");
  const match = /=== system ===\n([\s\S]*?)=== user ===\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`Prompt ${version} must contain "=== system ===" and "=== user ===" sections`);
  return { version, system: match[1]!.trim(), user: match[2]!.trim() };
}

/** Replaces {{name}} placeholders; an unknown or unfilled placeholder is an error. */
export function render(template: string, vars: Readonly<Record<string, string>>): string {
  const out = template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Missing prompt variable {{${name}}}`);
    return value;
  });
  return out;
}
