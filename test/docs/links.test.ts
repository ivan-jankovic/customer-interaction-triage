// P14: every relative link and #anchor in the README and the guide points at something that
// exists, so moving or renaming a file or heading can't leave a dead link behind.

import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS, ROOT, anchors, links, readDoc, slug } from "./markdown.js";

const isExternal = (t: string) => /^(https?:|mailto:)/.test(t);

describe("slug (GitHub anchor rules)", () => {
  it.each([
    ["Opus vs Sonnet", "opus-vs-sonnet"],
    ["In CI", "in-ci"],
    ["Phase 14 — README: Plan", "phase-14--readme-plan"],
    ["What `show` prints", "what-show-prints"],
    ["Migration `0008`: `reviews` and `unmask_log`", "migration-0008-reviews-and-unmask_log"],
    ["Investigating technical faults", "investigating-technical-faults"],
    ["P13: Review web page", "p13-review-web-page"],
    ["✅ P13: Review web page", "-p13-review-web-page"],
    ["Česká čísla", "česká-čísla"],
  ])("%s → %s", (heading, expected) => {
    expect(slug(heading)).toBe(expected);
  });

  it("numbers repeated headings", () => {
    expect([...anchors("# A\n## Notes\n## Notes\n## Notes")]).toEqual(["a", "notes", "notes-1", "notes-2"]);
  });

  it("ignores links and headings inside code", () => {
    const md = "Text [ok](a.md) and `[no](b.md)`\n```sh\n# not a heading\n[no](c.md)\n```\n## Real";
    expect(links(md).map((l) => l.target)).toEqual(["a.md"]);
    expect([...anchors(md)]).toEqual(["real"]);
  });
});

describe.each(DOCS)("links in %s", (doc) => {
  const md = readDoc(doc);
  const relative = links(md).filter((l) => !isExternal(l.target));

  it("has links to check", () => {
    expect(relative.length).toBeGreaterThan(0);
  });

  it.each(relative.map((l) => [`line ${l.line}: ${l.target}`, l] as const))("%s resolves", (_label, link) => {
    const [path, anchor] = link.target.split("#") as [string, string | undefined];
    const file = path === "" ? doc : normalize(join(dirname(doc), decodeURIComponent(path)));
    expect(file.startsWith(".."), `${link.target} leaves the repository`).toBe(false);
    expect(existsSync(join(ROOT, file)), `${file} exists`).toBe(true);
    if (anchor !== undefined) {
      expect(file.endsWith(".md"), `#${anchor} points into a Markdown file`).toBe(true);
      expect([...anchors(readDoc(file))], `#${anchor} in ${file}`).toContain(anchor);
    }
  });
});
