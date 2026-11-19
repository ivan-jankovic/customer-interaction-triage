// Enrichment rules (P06 requirements.md, "Enrichment rules"), on small hand-made CRM fixtures.

import { describe, expect, it } from "vitest";
import type { SeedCustomer, SeedOutage, SeedService } from "../../src/db/crm-seed.js";
import { memoryCrm } from "../../src/pipeline/crm-memory.js";
import { enrich, lookupKey, normalizeArea, type EnrichInput } from "../../src/pipeline/enrich.js";
import { mask } from "../../src/pipeline/mask.js";
import type { ServiceType } from "../../src/taxonomy.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(1);
const B = id(2);
const C = id(3);

const customer = (cid: string, customer_number: string, email: string | null): SeedCustomer => ({
  id: cid,
  customer_number,
  email,
  segment: "residential",
  created_at: "2020-01-01T00:00:00Z",
});
let serviceN = 100;
const service = (customer_id: string, s: Partial<SeedService>): SeedService => ({
  id: id(serviceN++),
  customer_id,
  service_type: "internet",
  tariff: "Merelo Fiber 300",
  contract_number: `SML-2020-${String(serviceN).padStart(5, "0")}`,
  phone: null,
  area: "Opava",
  status: "active",
  started_at: "2020-01-01T00:00:00Z",
  ...s,
});
const outage = (n: number, o: Partial<SeedOutage>): SeedOutage => ({
  id: id(200 + n),
  area: "Opava",
  service_type: "internet",
  description: "Fibre cut",
  started_at: "2026-11-03T08:00:00Z",
  resolved_at: "2026-11-03T16:00:00Z",
  ...o,
});

const customers = [
  customer(A, "MR11111111", "anna@example.net"),
  customer(B, "MR22222222", "shared@example.net"),
  customer(C, "MR33333333", "shared@example.net"),
];
const services = [
  service(A, { contract_number: "SML-2021-00001", area: "Ostrava-Poruba" }),
  service(A, { service_type: "mobile", phone: "+420777123456", area: "Ostrava-Poruba" }),
  service(B, { service_type: "mobile", phone: "+420602000111", status: "terminated", area: "Kladno" }),
  service(C, { service_type: "mobile", phone: "+421905000222", area: "Žilina" }),
  // C also has internet in another town: no single area.
  service(C, { area: "Trnava" }),
];
const outages = [
  outage(1, { area: "Ostrava-Poruba" }),
  outage(2, { area: "Ostrava-Poruba", service_type: "mobile" }),
  outage(3, { area: "Kladno", resolved_at: null }),
  outage(4, { area: "Kladno", started_at: "2026-11-01T00:00:00Z", resolved_at: "2026-11-02T00:00:00Z" }),
];
const crm = memoryCrm({ customers, services, outages });

const AT = new Date("2026-11-03T10:00:00Z");
function input(text: string, area: string | null = null, serviceType: ServiceType = "internet", at = AT): EnrichInput {
  return { identifiers: mask(text).identifiers, area, serviceType, receivedAt: at };
}
const run = (...args: Parameters<typeof input>) => enrich(input(...args), crm);

describe("customer lookup", () => {
  it.each([
    ["customer number", "Moje číslo je MR11111111."],
    ["customer number, lower case", "číslo zákazníka mr11111111"],
    ["contract number", "smlouva SML-2021-00001"],
    ["contract number, lower case", "smlouva sml-2021-00001"],
    ["e-mail, mixed case", "pište na Anna@Example.NET"],
    ["phone, national in groups", "volejte 777 123 456"],
    ["phone, national block", "volejte 777123456"],
    ["phone, +420 with spaces", "volejte +420 777 123 456"],
    ["phone, 00420", "volejte 00420777123456"],
  ])("finds the customer by %s", async (_name, text) => {
    const result = await run(text);
    expect(result.outcome).toBe("found");
    expect(result.customerId).toBe(A);
    expect(result.unmatchedPlaceholders).toEqual([]);
  });

  it("matches a +421 phone by its national part", async () => {
    expect((await run("číslo +421 905 000 222")).customerId).toBe(C);
  });

  it("is no_identifiers without keys, even with a birth number, account and IBAN", async () => {
    const result = await run("RČ 850312/1234, účet 1234567890/0100, IBAN CZ65 0800 0000 1920 0014 5399");
    expect(result).toMatchObject({ outcome: "no_identifiers", customerId: null, candidates: [] });
    expect((await run("Nefunguje mi internet.")).outcome).toBe("no_identifiers");
  });

  it("is not_found when no key matches, listing every key as unmatched", async () => {
    const result = await run("MR99999999, nobody@example.net");
    expect(result).toMatchObject({ outcome: "not_found", customerId: null, candidates: [] });
    expect(result.unmatchedPlaceholders).toEqual(["[CUSTOMER_NUMBER_1]", "[EMAIL_1]"]);
  });

  it("is found with an unmatched key listed", async () => {
    const result = await run("MR11111111, nový e-mail new@example.net");
    expect(result.outcome).toBe("found");
    expect(result.customerId).toBe(A);
    expect(result.candidates).toEqual([{ customerId: A, placeholders: ["[CUSTOMER_NUMBER_1]"] }]);
    expect(result.unmatchedPlaceholders).toEqual(["[EMAIL_1]"]);
  });

  it("collects every key that matched the same customer", async () => {
    const result = await run("MR11111111, tel. 777 123 456");
    expect(result.candidates).toEqual([{ customerId: A, placeholders: ["[CUSTOMER_NUMBER_1]", "[PHONE_1]"] }]);
  });

  it("is ambiguous when one key belongs to two customers", async () => {
    const result = await run("shared@example.net");
    expect(result.outcome).toBe("ambiguous");
    expect(result.customerId).toBeNull();
    expect(result.candidates).toEqual([
      { customerId: B, placeholders: ["[EMAIL_1]"] },
      { customerId: C, placeholders: ["[EMAIL_1]"] },
    ]);
  });

  it("is ambiguous when two keys point at different customers", async () => {
    const result = await run("MR11111111 a MR33333333");
    expect(result.outcome).toBe("ambiguous");
    expect(result.candidates.map((c) => c.customerId)).toEqual([A, C]);
  });

  it("matches a terminated service", async () => {
    expect((await run("tel. 602 000 111")).customerId).toBe(B);
  });
});

describe("outage check", () => {
  it("matches the area ignoring case and diacritics, of the classified service type", async () => {
    const result = await run("", "ostrava-PORUBA", "internet");
    expect(result).toMatchObject({ area: "ostrava-PORUBA", areaSource: "message", outageIds: [id(201)] });
    expect((await run("", "Ostrava-Poruba", "mobile")).outageIds).toEqual([id(202)]);
  });

  it("matches outages of any type when the service type is unknown", async () => {
    expect((await run("", "Ostrava-Poruba", "unknown")).outageIds).toEqual([id(201), id(202)]);
  });

  it("matches nothing of another type, in another area, or for no area", async () => {
    expect((await run("", "Ostrava-Poruba", "tv")).outageIds).toEqual([]);
    expect((await run("", "Opava")).outageIds).toEqual([]);
    expect(await run("")).toMatchObject({ area: null, areaSource: null, outageIds: [] });
  });

  it("checks the window against received_at", async () => {
    const at = (iso: string) => run("", "Ostrava-Poruba", "internet", new Date(iso));
    expect((await at("2026-11-03T08:00:00Z")).outageIds).toEqual([id(201)]); // starts exactly then
    expect((await at("2026-11-03T07:59:59Z")).outageIds).toEqual([]);
    expect((await at("2026-11-03T15:59:59Z")).outageIds).toEqual([id(201)]);
    expect((await at("2026-11-03T16:00:00Z")).outageIds).toEqual([]); // resolved exactly then
  });

  it("matches an ongoing outage and not one resolved earlier", async () => {
    expect((await run("", "Kladno", "internet")).outageIds).toEqual([id(203)]);
    expect((await run("", "Kladno", "internet", new Date("2026-11-01T12:00:00Z"))).outageIds).toEqual([id(204)]);
  });
});

describe("area fallback", () => {
  it("uses the found customer's service area when the message names none", async () => {
    const result = await run("MR11111111", null, "internet");
    expect(result).toMatchObject({ area: "Ostrava-Poruba", areaSource: "customer", outageIds: [id(201)] });
  });

  it("prefers the message's area", async () => {
    expect(await run("MR11111111", "Opava")).toMatchObject({ area: "Opava", areaSource: "message" });
  });

  it("uses a terminated service when it is the only one", async () => {
    expect(await run("MR22222222", null, "unknown")).toMatchObject({ area: "Kladno", areaSource: "customer" });
  });

  it("uses the service of the classified type when the customer's services span several areas", async () => {
    expect(await run("MR33333333", null, "mobile")).toMatchObject({ area: "Žilina", areaSource: "customer" });
    expect(await run("MR33333333", null, "internet")).toMatchObject({ area: "Trnava", areaSource: "customer" });
  });

  it("gives no area when the relevant services are in several areas", async () => {
    expect(await run("MR33333333", null, "unknown")).toMatchObject({ area: null, areaSource: null, outageIds: [] });
    expect(await run("MR33333333", null, "tv")).toMatchObject({ area: null, areaSource: null });
  });

  it("does not fall back when not found or ambiguous", async () => {
    expect(await run("MR99999999")).toMatchObject({ area: null, areaSource: null });
    expect(await run("shared@example.net")).toMatchObject({ area: null, areaSource: null });
  });
});

describe("helpers", () => {
  it("lookupKey normalises each key type", () => {
    expect(lookupKey("phone", "+420 777 123 456")).toBe("777123456");
    expect(lookupKey("phone", "00421905000222")).toBe("905000222");
    expect(lookupKey("email", " A@B.cz ")).toBe("a@b.cz");
    expect(lookupKey("customer_number", "mr 1234 5678")).toBe("MR12345678");
  });

  it("normalizeArea ignores case, diacritics and spaces", () => {
    expect(normalizeArea(" České  Budějovice ")).toBe("ceske budejovice");
    expect(normalizeArea("Žilina")).toBe(normalizeArea("zilina"));
  });
});
