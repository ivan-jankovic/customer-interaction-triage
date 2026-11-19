// The mock CRM seed (P06 validation.md, "Seed"): deterministic, committed as generated, valid,
// and made only of fictional values in the dataset's formats.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateFromFiles, renderSeed } from "../../eval/crm/generate.js";
import { RESERVED_MAIL_DOMAINS } from "../../eval/dataset/identifiers.js";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import type { DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import { AREAS, SERVICES } from "../../src/company.js";
import { CRM_SEED_PATH, readCrmSeed, validateCrmSeed } from "../../src/db/crm-seed.js";
import { lookupKey, type LookupKeyType } from "../../src/pipeline/enrich.js";

const seed = readCrmSeed();
const records = [...readJsonl<DatasetRecord>(PATHS.dataset), ...readJsonl<DatasetRecord>(PATHS.injection)];
const labelsOf = (r: DatasetRecord) => r.final ?? r.chosen;

describe("the CRM seed", () => {
  it("is deterministic, and the committed file equals a fresh generation", () => {
    const first = renderSeed(generateFromFiles());
    expect(renderSeed(generateFromFiles())).toBe(first);
    expect(readFileSync(CRM_SEED_PATH, "utf8"), "run `npm run crm:generate`").toBe(first);
  });

  it("matches its schema", () => {
    expect(validateCrmSeed(seed), JSON.stringify(validateCrmSeed.errors)).toBe(true);
  });

  it("has unique IDs, customer numbers and contract numbers, and consistent references", () => {
    const all = [...seed.customers, ...seed.services, ...seed.tickets, ...seed.outages].map((x) => x.id);
    expect(new Set(all).size).toBe(all.length);
    const unique = (values: string[]) => expect(new Set(values).size).toBe(values.length);
    unique(seed.customers.map((c) => c.customer_number));
    unique(seed.services.map((s) => s.contract_number));
    const customerIds = new Set(seed.customers.map((c) => c.id));
    const serviceIds = new Set(seed.services.map((s) => s.id));
    for (const s of seed.services) expect(customerIds.has(s.customer_id)).toBe(true);
    for (const t of seed.tickets) {
      expect(customerIds.has(t.customer_id)).toBe(true);
      if (t.service_id) expect(serviceIds.has(t.service_id)).toBe(true);
    }
    for (const c of seed.customers) expect(seed.services.some((s) => s.customer_id === c.id)).toBe(true);
  });

  it("uses only the company's tariffs and areas, and phones only on mobile services", () => {
    const areas = new Set<string>([...AREAS.CZ, ...AREAS.SK]);
    for (const s of seed.services) {
      expect(SERVICES[s.service_type].map((t) => t.name)).toContain(s.tariff);
      expect(areas).toContain(s.area);
      expect(s.phone !== null).toBe(s.service_type === "mobile");
    }
    for (const o of seed.outages) expect(areas).toContain(o.area);
  });

  it("uses only fictional values: reserved e-mail domains and phones starting with 0", () => {
    for (const c of seed.customers) {
      if (c.email) expect(RESERVED_MAIL_DOMAINS).toContain(c.email.split("@")[1]);
    }
    for (const s of seed.services) if (s.phone) expect(s.phone).toMatch(/^\+42[01]0\d{8}$/);
  });

  it("holds no names, birth numbers, bank accounts or IBANs", () => {
    const text = readFileSync(CRM_SEED_PATH, "utf8");
    expect(text).not.toMatch(/"(name|first_name|last_name|street|address|birth_number|bank_account|iban)"/);
    expect(text).not.toMatch(/\b\d{6}\/\d{3,4}\b/); // birth number or account shape
    expect(text).not.toMatch(/\b(CZ|SK)\d{2}\s?\d{4}/); // IBAN shape
  });

  it("generates no key that another message uses, other than the designed shared keys", () => {
    // Every CRM key that equals a message's key must belong to that message's design.
    const owners = new Map<string, string[]>();
    for (const r of records) {
      for (const i of labelsOf(r).fields.identifiers) {
        if (!["customer_number", "contract_number", "phone", "email"].includes(i.type)) continue;
        const k = `${i.type}:${lookupKey(i.type as LookupKeyType, i.value)}`;
        owners.set(k, [...(owners.get(k) ?? []), r.id]);
      }
    }
    for (const [k, ids] of owners) expect(ids, k).toHaveLength(1);
    // Injection messages' keys (P11, crm-generate.v3) are held only by that message's own
    // injection customer, never by a dataset or filler customer.
    const keysOfCustomer = (id: string) => [
      ...seed.customers
        .filter((c) => c.id === id)
        .flatMap((c) => [
          `customer_number:${lookupKey("customer_number", c.customer_number)}`,
          ...(c.email ? [`email:${lookupKey("email", c.email)}`] : []),
        ]),
      ...seed.services
        .filter((s) => s.customer_id === id)
        .flatMap((s) => [
          `contract_number:${lookupKey("contract_number", s.contract_number)}`,
          ...(s.phone ? [`phone:${lookupKey("phone", s.phone)}`] : []),
        ]),
    ];
    const crmKeys = new Set(seed.customers.flatMap((c) => keysOfCustomer(c.id)));
    const injectionOwner = new Map<string, string>();
    for (const m of seed.injection) {
      if (m.expected.customer_id)
        for (const k of keysOfCustomer(m.expected.customer_id)) injectionOwner.set(k, m.message_id);
    }
    const injectionKeys = [...owners].filter(([, ids]) => ids[0]!.startsWith("inj-"));
    for (const [k, ids] of injectionKeys) {
      if (crmKeys.has(k)) expect(injectionOwner.get(k), k).toBe(ids[0]);
    }
    expect(injectionKeys.filter(([k]) => crmKeys.has(k))).toHaveLength(injectionKeys.length);
  });

  it("places every message in the demo week, Monday to Friday", () => {
    for (const m of [...seed.messages, ...seed.injection]) {
      expect(m.received_at >= "2026-11-01T23:00:00.000Z" && m.received_at < "2026-11-06T23:00:00.000Z").toBe(true);
    }
  });

  it("starts every service before the demo week", () => {
    for (const s of seed.services) expect(s.started_at < "2026-11-01T00:00:00.000Z").toBe(true);
  });
});
