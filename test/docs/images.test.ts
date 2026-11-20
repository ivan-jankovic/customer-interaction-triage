// P14: the README's images are committed screenshots in docs/images/, small enough for the
// repository and with alt text for readers who can't see them.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, links, readDoc } from "./markdown.js";

const MAX_IMAGE_BYTES = 500 * 1024;

const committedImages = (): string[] => {
  try {
    return readdirSync(join(ROOT, "docs/images"))
      .filter((f) => !f.startsWith("."))
      .map((f) => `docs/images/${f}`);
  } catch {
    return [];
  }
};

describe("images in README.md", () => {
  const images = links(readDoc("README.md")).filter((l) => l.image);

  it.each(images.map((i) => [i.target, i] as const))("%s is in docs/images/, small, with alt text", (_t, image) => {
    expect(image.target, "a relative path under docs/images/").toMatch(/^docs\/images\/[\w.-]+\.(png|jpg|svg)$/);
    expect(image.text.trim().length, "alt text").toBeGreaterThan(0);
    const size = statSync(join(ROOT, image.target)).size;
    expect(size, `${image.target} is ${Math.round(size / 1024)} KB`).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
  });

  it("uses every file in docs/images/ (no stray images in the repository)", () => {
    const used = new Set(images.map((i) => i.target));
    expect(committedImages().filter((f) => !used.has(f))).toEqual([]);
  });
});
