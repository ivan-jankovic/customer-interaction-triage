// Dataset loader with a fake fetch: no server, no network.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFile } from "../../eval/dataset/load.js";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";

const KEY = "k".repeat(32);

function tempFile(records: object[]): string {
  const file = join(mkdtempSync(join(tmpdir(), "load-test-")), "records.jsonl");
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

/** A fake fetch that records requests and answers with the given statuses in turn. */
function fakeFetch(statuses: number[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init! });
    const status = statuses[calls.length - 1] ?? 201;
    return Promise.resolve(new Response(JSON.stringify({ status }), { status }));
  };
  const typed: typeof fetch = fn;
  return { calls, fetch: typed };
}

describe("loadFile", () => {
  it("sends only external_id, channel, language and text of a real dataset record, never labels", async () => {
    const [record] = readJsonl<Record<string, unknown>>(PATHS.dataset);
    const { calls, fetch } = fakeFetch([201]);
    await loadFile({ file: tempFile([record!]), apiUrl: "http://api.test", apiKey: KEY, fetch, log: () => {} });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://api.test/interactions");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["channel", "external_id", "language", "text"]);
    expect(body).toEqual({
      external_id: record!.id,
      channel: record!.channel,
      language: record!.language,
      text: record!.text,
    });
    for (const label of ["intent", "final", "chosen", "must_review", "complaint"]) {
      expect(calls[0]?.init.body).not.toContain(`"${label}"`);
    }
  });

  it("counts created, existing and failed records and reports each failure", async () => {
    const records = ["a", "b", "c", "d"].map((id) => ({ id, channel: "chat", language: "cs", text: `text ${id}` }));
    const { fetch } = fakeFetch([201, 200, 400, 201]);
    const lines: string[] = [];
    const report = await loadFile({
      file: tempFile(records),
      apiUrl: "http://api.test",
      apiKey: KEY,
      fetch,
      log: (l) => lines.push(l),
    });
    expect(report).toMatchObject({ created: 2, existing: 1 });
    expect(report.failed).toEqual([{ id: "c", reason: expect.stringContaining("HTTP 400") as string }]);
    expect(lines.at(-1)).toContain("4 records");
    expect(lines.at(-1)).toContain("2 created, 1 already present, 1 failed");
  });

  it("stops after a 401, since a wrong key fails every record", async () => {
    const records = ["a", "b", "c"].map((id) => ({ id, channel: "chat", language: "cs", text: id }));
    const { calls, fetch } = fakeFetch([401]);
    const report = await loadFile({ file: tempFile(records), apiUrl: "http://x", apiKey: KEY, fetch, log: () => {} });
    expect(calls).toHaveLength(1);
    expect(report.failed).toHaveLength(1);
  });

  it("fails with a clear message when the API is unreachable", async () => {
    const fetch = (() => Promise.reject(new TypeError("fetch failed"))) as typeof globalThis.fetch;
    await expect(
      loadFile({
        file: tempFile([{ id: "a", channel: "chat", language: "cs", text: "x" }]),
        apiUrl: "http://localhost:1",
        apiKey: KEY,
        fetch,
        log: () => {},
      }),
    ).rejects.toThrow(/Cannot reach the intake API at http:\/\/localhost:1.*docker compose up/);
  });

  it("fails when the file does not exist", async () => {
    await expect(
      loadFile({ file: "/nonexistent/x.jsonl", apiUrl: "http://x", apiKey: KEY, log: () => {} }),
    ).rejects.toThrow("File not found");
  });
});
