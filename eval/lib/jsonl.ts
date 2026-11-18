import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(`${path}:${i + 1}: invalid JSON (${String(error)})`, { cause: error });
      }
    });
}

/** Atomic write: a crash mid-write never leaves a truncated file behind. */
export function writeJsonl(path: string, rows: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  renameSync(tmp, path);
}

export function appendJsonl(path: string, row: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");
}
