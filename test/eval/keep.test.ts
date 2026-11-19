import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRunDir } from "../../eval/report/cli.js";
import { keepRun } from "../../eval/report/keep.js";

function results(): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-keep-"));
  mkdirSync(join(dir, "run-1"));
  writeFileSync(join(dir, "run-1", "run.json"), "{}");
  return dir;
}

describe("eval:keep and run lookup", () => {
  it("moves a run into kept/ and finds it there afterwards", () => {
    const dir = results();
    expect(resolveRunDir("run-1", dir)).toBe(join(dir, "run-1"));
    expect(keepRun("run-1", dir)).toBe(join(dir, "kept", "run-1"));
    expect(existsSync(join(dir, "run-1"))).toBe(false);
    expect(resolveRunDir("run-1", dir)).toBe(join(dir, "kept", "run-1"));
  });

  it("fails clearly for an unknown run", () => {
    const dir = results();
    expect(() => keepRun("nope", dir)).toThrow(/No run "nope"/);
    expect(() => resolveRunDir("nope", dir)).toThrow(/No run "nope"/);
  });
});
