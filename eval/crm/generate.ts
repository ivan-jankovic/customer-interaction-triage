// The mock CRM seed generator (P06 requirements.md, "Seed file"). No model: plain code with a
// fixed RNG, so the same dataset always gives the same seed.json.
//
// It reads the dataset's final labels and builds customers, services, tickets and outages that
// match them, a fixed received_at per message, and the enrichment each message is designed to
// get ("expected"). The expectations come from the design lists below, not from running
// src/pipeline/enrich.ts, so the dataset-wide test (test/pipeline/enrich-dataset.test.ts)
// checks the rules against an independent statement of what should happen.
//
// P10 (crm-generate.v2) adds line status per service and the likely cause each technical fault
// is designed to have ("expected_cause"), in a last step with its own RNG, so everything
// crm-generate.v1 wrote stays byte for byte the same (and the expected enrichments with it).
//
// P11 (crm-generate.v3) adds one customer per injection message with an account key, so the
// injection set's review comes from the real rules and not from customer_not_found. Also a last
// step with its own RNG: everything crm-generate.v2 wrote stays byte for byte the same.
//
// Usage: npm run crm:generate   (rewrites eval/data/crm/seed.json; then npm run crm:seed)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { AREAS, SERVICES } from "../../src/company.js";
import {
  CRM_SEED_PATH,
  type CrmSeed,
  type SeedCustomer,
  type SeedLineStatus,
  type SeedMessage,
  type SeedOutage,
  type SeedService,
  type SeedTicket,
} from "../../src/db/crm-seed.js";
import {
  isLookupKeyType,
  lookupKey,
  normalizeArea,
  type CrmServiceType,
  type LookupKeyType,
} from "../../src/pipeline/enrich.js";
import type { Intent, Language, LikelyCause } from "../../src/taxonomy.js";
import * as ids from "../dataset/identifiers.js";
import { sha256File } from "../lib/hash.js";
import { readJsonl } from "../lib/jsonl.js";
import { PATHS } from "../lib/paths.js";
import { createRng, type Rng } from "../lib/rng.js";
import type { DatasetRecord } from "../schema/dataset-record.schema.js";

export const GENERATOR = "crm-generate.v3";
export const SEED = 20261102;
/** The RNG seed of the line-status step (P10), separate so the v1 part of the seed is unchanged. */
export const LINE_STATUS_SEED = 20261119;
/** The RNG seed of the injection step (P11), separate so the v2 part of the seed is unchanged. */
export const INJECTION_SEED = 20261120;

// ---------------------------------------------------------------------------------------------
// The design: which messages exercise which path. Reviewed by hand; everything else is "found"
// (when the message has an account key) or "no_identifiers".
// ---------------------------------------------------------------------------------------------

/** Keys are left out of the CRM. */
export const NOT_FOUND = ["msg-001", "msg-009", "msg-031", "msg-087", "msg-097"] as const;

/** The key also belongs to a second customer: a shared family e-mail, or a phone number moved on. */
export const AMBIGUOUS_SHARED: Readonly<Record<string, LookupKeyType>> = {
  "msg-022": "email",
  "msg-042": "email",
  "msg-069": "phone",
};

/** This key belongs to a different customer than the message's other key. */
export const AMBIGUOUS_SPLIT: Readonly<Record<string, LookupKeyType>> = {
  "msg-014": "phone",
  "msg-059": "email",
};

/** The customer is found by another key; this one is unknown to the CRM. */
export const UNMATCHED_KEY: Readonly<Record<string, LookupKeyType>> = {
  "msg-008": "email",
  "msg-055": "phone",
  "msg-074": "email",
};

/** Technical faults with an ongoing outage of their service type in their area. */
export const OUTAGE_MATCH = [
  "msg-011",
  "msg-012",
  "msg-018",
  "msg-029",
  "msg-037",
  "msg-051",
  "msg-056",
  "msg-084",
] as const;

/** Technical faults with an outage in their area that must not match. */
export const OUTAGE_NEAR_MISS: Readonly<Record<string, "resolved_earlier" | "other_service">> = {
  "msg-021": "resolved_earlier",
  "msg-036": "other_service",
  "msg-063": "resolved_earlier",
  "msg-079": "other_service",
};

/** Outages in areas no message names. */
export const OUTAGE_ELSEWHERE: readonly { area: string; service_type: CrmServiceType }[] = [
  { area: "Zlín", service_type: "internet" },
  { area: "Jihlava", service_type: "tv" },
  { area: "Prešov", service_type: "mobile" },
];

export const FILLER_CUSTOMERS = 20;

/**
 * P10: technical faults whose found customer's line is down with no outage to explain it. The
 * service gets an open fault ticket too. Faults in OUTAGE_MATCH are `area_outage`.
 */
export const LINE_FAULT = ["msg-071"] as const;

/**
 * P10: technical faults about a found customer's service that isn't active. None in this
 * dataset. msg-069 (the phone number moved to another customer) was first designed as
 * service_inactive, then relabelled inconclusive during review: the number matches two
 * customers, so the tools can't tell who is calling or which service the message is about.
 */
export const SERVICE_INACTIVE: readonly string[] = [];

/**
 * P10: technical faults whose found customer's line is up with no outage. None in this dataset:
 * the only found fault without an outage (msg-071) is a line fault (requirements.md, Notes).
 */
export const CUSTOMER_EQUIPMENT: readonly string[] = [];

/** Monday 2026-11-02, Prague time (UTC+1 in November). Messages arrive Mon–Fri, 08:00–19:59. */
const WEEK_START_UTC = Date.parse("2026-11-02T00:00:00+01:00");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------------------------

const OUTAGE_DESCRIPTIONS: Readonly<Record<CrmServiceType, readonly string[]>> = {
  internet: [
    "Fibre cable damaged during roadworks; fixed internet down in the area.",
    "Power failure at the local access node; fixed internet unavailable.",
    "Faulty aggregation switch; fixed internet down or very slow.",
  ],
  mobile: [
    "Base station outage; no mobile signal in parts of the area.",
    "Mobile network maintenance overran; calls and data unavailable.",
    "Transmission link failure; mobile calls, SMS and data down.",
  ],
  tv: [
    "Headend fault; TV channels unavailable or freezing.",
    "TV platform update failed; set-top boxes cannot load channels.",
  ],
};

const TICKET_SUMMARIES: Readonly<Record<Intent, readonly string[]>> = {
  billing_question: [
    "Customer asked about an item on the monthly invoice; explained.",
    "Question about a payment that did not show up; payment matched.",
  ],
  technical_fault: [
    "Customer reported no connection; router restarted remotely.",
    "Slow speeds reported in the evenings; line checked, no fault found.",
    "Intermittent dropouts reported; technician visit offered.",
  ],
  tariff_change: ["Customer asked about a higher tariff; offer sent.", "Tariff changed at the customer's request."],
  cancellation: ["Customer asked about the notice period; information given."],
  complaint: ["Complaint about a late technician visit; apology and credit given."],
  other: ["Postal address updated.", "Customer asked for a copy of the contract; sent by e-mail."],
};

const FAULT_TICKET = "Customer reported the service not working; ticket open while investigated.";

const LINE_UP: Readonly<Record<CrmServiceType, string>> = {
  internet: "In sync; no errors on the access port.",
  mobile: "Registered on the network; no errors.",
  tv: "Set-top box online; streams delivered.",
};
const LINE_TERMINATED = "Service terminated; line deprovisioned.";
const LINE_DOWN_OUTAGE: Readonly<Record<CrmServiceType, string>> = {
  internet: "No sync on the access port; the access node is unreachable.",
  mobile: "SIM not registered; the serving cell is unreachable.",
  tv: "Set-top box offline; the headend is unreachable.",
};
const LINE_DOWN_FAULT: Readonly<Record<CrmServiceType, string>> = {
  internet: "No sync on the access port; the access node is reachable and other lines on it are up.",
  mobile: "SIM not registered on the network; the serving cell is up and other subscribers are connected.",
  tv: "Set-top box offline; the headend is up and other boxes are connected.",
};

// ---------------------------------------------------------------------------------------------

type Key = { type: LookupKeyType; value: string };

interface Context {
  rng: Rng;
  /** lookupKey-normalised values in use (dataset, injection and generated), per key type. */
  used: Set<string>;
  customers: SeedCustomer[];
  services: SeedService[];
  tickets: SeedTicket[];
  outages: SeedOutage[];
}

const usedKey = (type: LookupKeyType, value: string) => `${type}:${lookupKey(type, value)}`;

/** A UUID in the v4 layout, drawn from the seeded RNG. */
function uuid(rng: Rng): string {
  const hex = Array.from({ length: 32 }, () => rng.int(0, 15).toString(16));
  hex[12] = "4";
  hex[16] = "89ab"[rng.int(0, 3)]!;
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** A generated value no message and no earlier generated value uses. */
function fresh(ctx: Context, type: LookupKeyType, generate: () => string): string {
  for (;;) {
    const value = generate();
    const key = usedKey(type, value);
    if (!ctx.used.has(key)) {
      ctx.used.add(key);
      return value;
    }
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

const KEY_LABEL: Readonly<Record<LookupKeyType, string>> = {
  customer_number: "customer number",
  contract_number: "contract number",
  phone: "phone number",
  email: "e-mail address",
};

/** The CRM's form of a phone: +420/+421 and the 9-digit national number. */
export function canonicalPhone(value: string, language: Language): string {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 9) return `${language === "sk" ? "+421" : "+420"}${digits}`;
  return `+${digits}`;
}

const canonicalContract = (value: string) => value.replace(/\s+/g, "").toUpperCase();
const canonicalCustomerNumber = (value: string) => value.replace(/\s+/g, "").toUpperCase();

const countryOf = (language: Language) => (language === "sk" ? "SK" : "CZ");

/** In the contract number's year, and at least 30 days before the demo week. */
function startOfContract(ctx: Context, contract: string): number {
  const year = Number(contract.slice(4, 8));
  return Math.min(Date.UTC(year, ctx.rng.int(0, 11), ctx.rng.int(1, 28), 9), WEEK_START_UTC - 30 * DAY);
}

function addService(
  ctx: Context,
  customerId: string,
  serviceType: CrmServiceType,
  area: string,
  language: Language,
  opts: { contract?: string; phone?: string | null; status?: "active" | "terminated" } = {},
): SeedService {
  const contract = opts.contract ?? fresh(ctx, "contract_number", () => ids.contractNumber(ctx.rng));
  const phone =
    serviceType === "mobile"
      ? (opts.phone ??
        canonicalPhone(
          fresh(ctx, "phone", () => ids.phone(ctx.rng, language)),
          language,
        ))
      : null;
  const service: SeedService = {
    id: uuid(ctx.rng),
    customer_id: customerId,
    service_type: serviceType,
    tariff: ctx.rng.pick(SERVICES[serviceType].map((s) => s.name)),
    contract_number: canonicalContract(contract),
    phone,
    area,
    status: opts.status ?? "active",
    started_at: iso(startOfContract(ctx, contract)),
  };
  ctx.services.push(service);
  return service;
}

function addCustomer(
  ctx: Context,
  opts: { customerNumber?: string; email?: string | null; language: Language },
): SeedCustomer {
  const customerNumber = opts.customerNumber ?? fresh(ctx, "customer_number", () => ids.customerNumber(ctx.rng));
  const email =
    opts.email !== undefined ? opts.email : ctx.rng.chance(0.6) ? fresh(ctx, "email", () => ids.email(ctx.rng)) : null;
  const customer: SeedCustomer = {
    id: uuid(ctx.rng),
    customer_number: canonicalCustomerNumber(customerNumber),
    email: email?.toLowerCase() ?? null,
    segment: ctx.rng.chance(0.15) ? "business" : "residential",
    created_at: "", // set once its services exist
  };
  ctx.customers.push(customer);
  return customer;
}

/** A customer exists from the start of their first service (or a day before, for clarity). */
function settleCreatedAt(ctx: Context): void {
  for (const c of ctx.customers) {
    const starts = ctx.services.filter((s) => s.customer_id === c.id).map((s) => Date.parse(s.started_at));
    c.created_at = iso(Math.min(...starts) - DAY);
  }
}

const OTHER_TYPES: Readonly<Record<CrmServiceType, readonly CrmServiceType[]>> = {
  internet: ["mobile", "tv"],
  mobile: ["internet", "tv"],
  tv: ["internet", "mobile"],
};

interface Planned {
  record: DatasetRecord;
  receivedAt: number;
  design: string;
  expected: SeedMessage["expected"];
}

/** P10: the cause a technical fault is designed to have; null for every other intent. */
export function designedCause(id: string, intent: Intent): LikelyCause | null {
  if (intent !== "technical_fault") return null;
  if ((OUTAGE_MATCH as readonly string[]).includes(id)) return "area_outage";
  if ((LINE_FAULT as readonly string[]).includes(id)) return "line_fault";
  if (SERVICE_INACTIVE.includes(id)) return "service_inactive";
  if (CUSTOMER_EQUIPMENT.includes(id)) return "customer_equipment";
  return "inconclusive";
}

export function generateSeed(
  dataset: readonly DatasetRecord[],
  injection: readonly DatasetRecord[],
  datasetHash = "",
): CrmSeed {
  const rng = createRng(SEED);
  const ctx: Context = { rng, used: new Set(), customers: [], services: [], tickets: [], outages: [] };
  const records = [...dataset].sort((a, b) => a.id.localeCompare(b.id));
  const labels = (r: DatasetRecord) => r.final ?? r.chosen;
  const keysOf = (r: DatasetRecord): Key[] =>
    labels(r).fields.identifiers.filter((i): i is Key => isLookupKeyType(i.type));

  for (const r of [...records, ...injection]) {
    for (const k of keysOf(r)) ctx.used.add(usedKey(k.type, k.value));
  }

  // Areas named by a message or an outage are kept free of other customers' fallback areas,
  // so a customer-area fallback never lands on an outage by accident.
  const outageAreas = new Set([
    ...OUTAGE_ELSEWHERE.map((o) => normalizeArea(o.area)),
    ...[...OUTAGE_MATCH, ...Object.keys(OUTAGE_NEAR_MISS)].map((id) => {
      const area = labels(records.find((r) => r.id === id)!).fields.area;
      return normalizeArea(area!);
    }),
  ]);
  const quiet = (country: "CZ" | "SK") => AREAS[country].filter((a) => !outageAreas.has(normalizeArea(a)));

  // 1. received_at for every message.
  const receivedAt = new Map<string, number>();
  for (const r of records) {
    receivedAt.set(r.id, WEEK_START_UTC + rng.int(0, 4) * DAY + rng.int(8 * 60, 20 * 60 - 1) * MINUTE);
  }

  // 2. Customers and services.
  const planned: Planned[] = [];
  const customerOf = new Map<string, SeedCustomer>();
  for (const r of records) {
    const l = labels(r);
    const keys = keysOf(r);
    const at = receivedAt.get(r.id)!;
    const labelledArea = l.fields.area;
    const lang = r.language;

    if (keys.length === 0) {
      planned.push({
        record: r,
        receivedAt: at,
        design: "no_identifiers: no account key in the message",
        expected: {
          outcome: "no_identifiers",
          customer_id: null,
          area: labelledArea,
          area_source: labelledArea ? "message" : null,
          outage_ids: [],
        },
      });
      continue;
    }
    if ((NOT_FOUND as readonly string[]).includes(r.id)) {
      planned.push({
        record: r,
        receivedAt: at,
        design: "not_found: the message's keys are left out of the CRM",
        expected: {
          outcome: "not_found",
          customer_id: null,
          area: labelledArea,
          area_source: labelledArea ? "message" : null,
          outage_ids: [],
        },
      });
      continue;
    }

    const shared = AMBIGUOUS_SHARED[r.id];
    const split = AMBIGUOUS_SPLIT[r.id];
    const unmatched = UNMATCHED_KEY[r.id];
    const keyOf = (type: LookupKeyType) => keys.find((k) => k.type === type)?.value;
    // Keys the message's own customer holds.
    const own = (type: LookupKeyType) => (type === split || type === unmatched ? undefined : keyOf(type));

    const area = labelledArea ?? rng.pick(quiet(countryOf(lang)));
    const mainType: CrmServiceType = l.fields.service_type === "unknown" ? "internet" : l.fields.service_type;
    const customer = addCustomer(ctx, {
      customerNumber: own("customer_number"),
      email: own("email") ?? undefined,
      language: lang,
    });
    customerOf.set(r.id, customer);
    const phone = own("phone");
    const movedPhone = shared === "phone";
    addService(ctx, customer.id, mainType, area, lang, {
      contract: own("contract_number"),
      phone: mainType === "mobile" && phone ? canonicalPhone(phone, lang) : undefined,
      status: movedPhone && mainType === "mobile" ? "terminated" : "active",
    });
    if (phone && mainType !== "mobile") {
      addService(ctx, customer.id, "mobile", area, lang, {
        phone: canonicalPhone(phone, lang),
        status: movedPhone ? "terminated" : "active",
      });
    }
    if (rng.chance(0.3)) addService(ctx, customer.id, rng.pick(OTHER_TYPES[mainType]), area, lang);
    if (rng.chance(0.15)) addService(ctx, customer.id, mainType, area, lang, { status: "terminated" });

    let design = "found: one customer holds every key in the message";
    let outcome: SeedMessage["expected"]["outcome"] = "found";
    const other = shared ?? split;
    if (other) {
      // A second customer, elsewhere, holds the shared or split key.
      const value = keyOf(other)!;
      const second = addCustomer(ctx, { email: other === "email" ? value : undefined, language: lang });
      const secondType: CrmServiceType = other === "phone" ? "mobile" : rng.pick(["internet", "tv"] as const);
      addService(ctx, second.id, secondType, rng.pick(quiet(countryOf(lang))), lang, {
        phone: other === "phone" ? canonicalPhone(value, lang) : undefined,
      });
      outcome = "ambiguous";
      design = shared
        ? shared === "phone"
          ? "ambiguous: the phone number moved to another customer; the old service is terminated"
          : "ambiguous: the e-mail address is shared with another customer"
        : `ambiguous: the ${KEY_LABEL[other]} belongs to a different customer than the other key`;
    } else if (unmatched) {
      design = `found, with the ${KEY_LABEL[unmatched]} unknown to the CRM`;
    }

    const found = outcome === "found";
    planned.push({
      record: r,
      receivedAt: at,
      design,
      expected: {
        outcome,
        customer_id: found ? customer.id : null,
        area: labelledArea ?? (found ? area : null),
        area_source: labelledArea ? "message" : found ? "customer" : null,
        outage_ids: [],
      },
    });
  }

  // 3. Filler customers, with no message.
  for (let i = 0; i < FILLER_CUSTOMERS; i++) {
    const lang: Language = rng.chance(0.25) ? "sk" : "cs";
    const c = addCustomer(ctx, { language: lang });
    const area = rng.pick(AREAS[countryOf(lang)]);
    const type = rng.pick(["internet", "mobile", "tv"] as const);
    addService(ctx, c.id, type, area, lang);
    if (rng.chance(0.4)) addService(ctx, c.id, rng.pick(OTHER_TYPES[type]), area, lang);
  }

  // 4. Outages. A window never covers another message in the same area, so expectations stay
  // as designed; the window is redrawn until that holds.
  const byId = new Map(planned.map((p) => [p.record.id, p]));
  const clashes = (area: string, start: number, end: number | null, except: string | null) =>
    planned.some(
      (p) =>
        p.record.id !== except &&
        p.expected.area !== null &&
        normalizeArea(p.expected.area) === normalizeArea(area) &&
        start <= p.receivedAt &&
        (end === null || p.receivedAt < end),
    );
  const addOutage = (
    area: string,
    serviceType: CrmServiceType,
    draw: () => { start: number; end: number | null },
    target: string | null,
  ): SeedOutage => {
    for (;;) {
      const { start, end } = draw();
      if (clashes(area, start, end, target)) continue;
      const outage: SeedOutage = {
        id: uuid(rng),
        area,
        service_type: serviceType,
        description: rng.pick(OUTAGE_DESCRIPTIONS[serviceType]),
        started_at: iso(start),
        resolved_at: end === null ? null : iso(end),
      };
      ctx.outages.push(outage);
      return outage;
    }
  };
  const typeOf = (id: string): CrmServiceType => {
    const t = labels(byId.get(id)!.record).fields.service_type;
    if (t === "unknown") throw new Error(`${id}: an outage message needs a known service type`);
    return t;
  };

  for (const id of OUTAGE_MATCH) {
    const p = byId.get(id)!;
    const at = p.receivedAt;
    // Started up to 6 hours before the message; a quarter are still ongoing.
    const outage = addOutage(
      p.expected.area!,
      typeOf(id),
      () => ({
        start: at - rng.int(30, 360) * MINUTE,
        end: rng.chance(0.25) ? null : at + rng.int(60, 480) * MINUTE,
      }),
      id,
    );
    p.expected.outage_ids = [outage.id];
    p.design += "; an outage of its service type in its area was ongoing when it arrived";
  }
  for (const [id, kind] of Object.entries(OUTAGE_NEAR_MISS)) {
    const p = byId.get(id)!;
    const at = p.receivedAt;
    if (kind === "resolved_earlier") {
      addOutage(
        p.expected.area!,
        typeOf(id),
        () => {
          const end = at - rng.int(60, 24 * 60) * MINUTE;
          return { start: end - rng.int(2, 10) * HOUR, end };
        },
        null,
      );
      p.design += "; an outage of its service type in its area was resolved before it arrived";
    } else {
      addOutage(
        p.expected.area!,
        rng.pick(OTHER_TYPES[typeOf(id)]),
        () => ({ start: at - rng.int(30, 360) * MINUTE, end: at + rng.int(60, 480) * MINUTE }),
        id,
      );
      p.design += "; an outage of another service type covers its area";
    }
  }
  for (const o of OUTAGE_ELSEWHERE) {
    addOutage(
      o.area,
      o.service_type,
      () => {
        const start = WEEK_START_UTC + rng.int(0, 4) * DAY + rng.int(0, 23) * HOUR;
        return { start, end: start + rng.int(2, 12) * HOUR };
      },
      null,
    );
  }

  // 5. Tickets: up to two old ones per customer, and a recent open one for some customers
  // whose message is a technical fault (P10's agent reads these).
  settleCreatedAt(ctx);
  for (const c of ctx.customers) {
    const services = ctx.services.filter((s) => s.customer_id === c.id);
    const from = Date.parse(c.created_at);
    for (let i = rng.int(0, 2); i > 0; i--) {
      const category = rng.pick(Object.keys(TICKET_SUMMARIES) as Intent[]);
      const opened = from + rng.int(1, Math.max(1, Math.floor((WEEK_START_UTC - DAY * 7 - from) / DAY))) * DAY;
      ctx.tickets.push({
        id: uuid(rng),
        customer_id: c.id,
        service_id: rng.chance(0.7) ? rng.pick(services).id : null,
        category,
        summary: rng.pick(TICKET_SUMMARIES[category]),
        opened_at: iso(opened),
        closed_at: iso(opened + rng.int(1, 72) * HOUR),
      });
    }
  }
  for (const p of planned) {
    const customer = customerOf.get(p.record.id);
    if (!customer || labels(p.record).intent !== "technical_fault" || !rng.chance(0.5)) continue;
    const service = ctx.services.find(
      (s) => s.customer_id === customer.id && s.service_type === labels(p.record).fields.service_type,
    );
    ctx.tickets.push({
      id: uuid(rng),
      customer_id: customer.id,
      service_id: service?.id ?? null,
      category: "technical_fault",
      summary: FAULT_TICKET,
      opened_at: iso(p.receivedAt - rng.int(1, 3) * DAY),
      closed_at: null,
    });
  }

  // 6. Line status and designed causes (P10), with their own RNG.
  const lrng = createRng(LINE_STATUS_SEED);
  const lineStatus = new Map<string, SeedLineStatus>();
  for (const s of ctx.services) {
    const started = Date.parse(s.started_at);
    lineStatus.set(
      s.id,
      s.status === "terminated"
        ? {
            service_id: s.id,
            state: "down",
            state_since: iso(Math.min(started + lrng.int(60, 900) * DAY, WEEK_START_UTC - 30 * DAY)),
            diagnostic: LINE_TERMINATED,
          }
        : { service_id: s.id, state: "up", state_since: s.started_at, diagnostic: LINE_UP[s.service_type] },
    );
  }
  const causes = new Map<string, LikelyCause | null>();
  for (const p of planned) {
    const l = labels(p.record);
    const cause = designedCause(p.record.id, l.intent);
    causes.set(p.record.id, cause);
    if (cause === null) continue;
    const customer = p.expected.outcome === "found" ? customerOf.get(p.record.id) : undefined;
    if (customer && cause === "inconclusive") {
      throw new Error(`${p.record.id}: a technical fault with a found customer needs a designed cause`);
    }
    if (!customer || (cause !== "area_outage" && cause !== "line_fault")) {
      p.design += `; designed cause ${cause}`;
      continue;
    }
    const service = ctx.services.find(
      (s) => s.customer_id === customer.id && s.status === "active" && s.service_type === l.fields.service_type,
    );
    if (!service) throw new Error(`${p.record.id}: no active ${l.fields.service_type} service to fail`);
    if (cause === "area_outage") {
      const outage = ctx.outages.find((o) => o.id === p.expected.outage_ids[0])!;
      lineStatus.set(service.id, {
        service_id: service.id,
        state: "down",
        state_since: iso(Date.parse(outage.started_at) + lrng.int(2, 15) * MINUTE),
        diagnostic: LINE_DOWN_OUTAGE[service.service_type],
      });
      p.design += "; designed cause area_outage: its line went down when the outage started";
    } else {
      lineStatus.set(service.id, {
        service_id: service.id,
        state: "down",
        state_since: iso(p.receivedAt - lrng.int(12 * 60, 36 * 60) * MINUTE),
        diagnostic: LINE_DOWN_FAULT[service.service_type],
      });
      const open = ctx.tickets.some((t) => t.service_id === service.id && t.closed_at === null);
      if (!open) {
        ctx.tickets.push({
          id: uuid(lrng),
          customer_id: customer.id,
          service_id: service.id,
          category: "technical_fault",
          summary: FAULT_TICKET,
          opened_at: iso(p.receivedAt - lrng.int(2, 10) * HOUR),
          closed_at: null,
        });
      }
      p.design += "; designed cause line_fault: its line is down with no outage, and a fault ticket is open";
    }
  }

  // 7. Injection messages (P11), with their own RNG: one customer per message with an account
  // key, holding exactly the message's keys and an active service of its service type. No new
  // outage; received_at is redrawn until no outage covers the message's area at that time.
  const irng = createRng(INJECTION_SEED);
  const ictx: Context = { ...ctx, rng: irng };
  const injectionMessages: SeedMessage[] = [];
  const startOfInjection = ctx.customers.length;
  for (const r of [...injection].sort((a, b) => a.id.localeCompare(b.id))) {
    const l = labels(r);
    const keys = keysOf(r);
    const lang = r.language;
    const keyOf = (type: LookupKeyType) => keys.find((k) => k.type === type)?.value;
    let customerId: string | null = null;
    let area = l.fields.area;
    let areaSource: SeedMessage["expected"]["area_source"] = area ? "message" : null;
    if (keys.length > 0) {
      area ??= irng.pick(quiet(countryOf(lang)));
      areaSource = l.fields.area ? "message" : "customer";
      const mainType: CrmServiceType = l.fields.service_type === "unknown" ? "internet" : l.fields.service_type;
      const customer = addCustomer(ictx, {
        customerNumber: keyOf("customer_number"),
        email: keyOf("email") ?? null,
        language: lang,
      });
      const phone = keyOf("phone");
      addService(ictx, customer.id, mainType, area, lang, {
        contract: keyOf("contract_number"),
        phone: mainType === "mobile" && phone ? canonicalPhone(phone, lang) : undefined,
      });
      if (phone && mainType !== "mobile") {
        addService(ictx, customer.id, "mobile", area, lang, { phone: canonicalPhone(phone, lang) });
      }
      customerId = customer.id;
    }
    let at: number;
    do {
      at = WEEK_START_UTC + irng.int(0, 4) * DAY + irng.int(8 * 60, 20 * 60 - 1) * MINUTE;
    } while (
      area !== null &&
      ctx.outages.some(
        (o) =>
          normalizeArea(o.area) === normalizeArea(area) &&
          Date.parse(o.started_at) <= at &&
          (o.resolved_at === null || at < Date.parse(o.resolved_at)),
      )
    );
    injectionMessages.push({
      message_id: r.id,
      received_at: iso(at),
      design:
        customerId === null
          ? "no_identifiers: no account key in the message (injection set)"
          : "found: one customer holds every key in the message (injection set); line up, no outage",
      expected: {
        outcome: customerId === null ? "no_identifiers" : "found",
        customer_id: customerId,
        area,
        area_source: areaSource,
        outage_ids: [],
      },
      expected_cause: null,
    });
  }
  for (const c of ctx.customers.slice(startOfInjection)) {
    const starts = ctx.services.filter((s) => s.customer_id === c.id).map((s) => Date.parse(s.started_at));
    c.created_at = iso(Math.min(...starts) - DAY);
  }
  for (const s of ctx.services) {
    if (!lineStatus.has(s.id)) {
      lineStatus.set(s.id, {
        service_id: s.id,
        state: "up",
        state_since: s.started_at,
        diagnostic: LINE_UP[s.service_type],
      });
    }
  }

  return {
    generator: GENERATOR,
    dataset_hash: datasetHash,
    customers: ctx.customers,
    services: ctx.services,
    tickets: ctx.tickets,
    outages: ctx.outages,
    line_status: ctx.services.map((s) => lineStatus.get(s.id)!),
    messages: planned.map((p) => ({
      message_id: p.record.id,
      received_at: iso(p.receivedAt),
      design: p.design,
      expected: p.expected,
      expected_cause: causes.get(p.record.id) ?? null,
    })),
    injection: injectionMessages,
  };
}

export function renderSeed(seed: CrmSeed): string {
  return JSON.stringify(seed, null, 2) + "\n";
}

export function generateFromFiles(): CrmSeed {
  return generateSeed(
    readJsonl<DatasetRecord>(PATHS.dataset),
    readJsonl<DatasetRecord>(PATHS.injection),
    sha256File(PATHS.dataset),
  );
}

function main(): void {
  const seed = generateFromFiles();
  mkdirSync(dirname(CRM_SEED_PATH), { recursive: true });
  writeFileSync(CRM_SEED_PATH, renderSeed(seed));
  const count = (o: string) => seed.messages.filter((m) => m.expected.outcome === o).length;
  console.log(
    `Wrote ${CRM_SEED_PATH}: ${seed.customers.length} customers, ${seed.services.length} services, ` +
      `${seed.tickets.length} tickets, ${seed.outages.length} outages, ${seed.line_status.length} line states; messages: ${count("found")} found, ` +
      `${count("not_found")} not found, ${count("ambiguous")} ambiguous, ${count("no_identifiers")} no identifiers.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
