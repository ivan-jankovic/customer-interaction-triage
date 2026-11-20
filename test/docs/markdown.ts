// Small Markdown helpers for the doc tests (P14): links, images and headings of a file, and
// GitHub's anchor slugs. Not a full Markdown parser: enough for this repo's docs, which use
// inline links only. Fenced code blocks and inline code spans are skipped, so commands and
// examples in code are never read as links.

import { readFileSync } from "node:fs";

export const ROOT = new URL("../../", import.meta.url).pathname;

export interface Link {
  /** `![alt](src)` is an image. */
  image: boolean;
  text: string;
  target: string;
  line: number;
}

/** The lines outside fenced code blocks, with inline code spans blanked out. */
function proseLines(markdown: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let fence: string | null = null;
  markdown.split("\n").forEach((raw, i) => {
    const m = /^\s*(```+|~~~+)/.exec(raw);
    if (m) {
      if (fence === null) fence = m[1]!.slice(0, 3);
      else if (m[1]!.startsWith(fence)) fence = null;
      return;
    }
    if (fence === null) out.push({ text: raw.replace(/`+[^`]*`+/g, (s) => " ".repeat(s.length)), line: i + 1 });
  });
  return out;
}

export function links(markdown: string): Link[] {
  const found: Link[] = [];
  for (const { text, line } of proseLines(markdown)) {
    for (const m of text.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      found.push({ image: m[1] === "!", text: m[2]!, target: m[3]!, line });
    }
    // Autolinks such as <http://localhost:3000/review> are external; nothing to check.
  }
  return found;
}

export function headings(markdown: string): string[] {
  return proseLinesWithCode(markdown)
    .map((l) => /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]!);
}

/** Like proseLines, but keeps code spans (a heading's slug includes their text). */
function proseLinesWithCode(markdown: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of markdown.split("\n")) {
    const m = /^\s*(```+|~~~+)/.exec(raw);
    if (m) {
      if (fence === null) fence = m[1]!.slice(0, 3);
      else if (m[1]!.startsWith(fence)) fence = null;
      continue;
    }
    if (fence === null) out.push(raw);
  }
  return out;
}

/**
 * GitHub's slug for one heading: the visible text, lower case, with everything except letters,
 * digits, spaces, "-" and "_" removed, and each space turned into "-" (so "A — B" gives "a--b").
 */
export function slug(heading: string): string {
  const visible = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links and images: their text
    .replace(/`/g, "")
    .replace(/\*\*|__|\*/g, "");
  return visible
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Every anchor of a file, with GitHub's "-1", "-2" suffixes for repeated headings. */
export function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const h of headings(markdown)) {
    const base = slug(h);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

export const readDoc = (path: string) => readFileSync(ROOT + path, "utf8");

/** The docs the tests check. */
export const DOCS = ["README.md", "docs/guide.md", "docs/results.md"] as const;
