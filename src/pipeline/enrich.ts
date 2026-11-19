// Step 4 of the pipeline: enrichment (P06 requirements.md, "Enrichment rules").
// Finds the customer in the mock CRM from the masking map's account keys, and the known outages
// for the message's area at the time it was received. Plain code, no model: it records facts
// ("two customers matched"); P07's routing rules decide what they mean.
//
// The CRM is reached through the small CrmLookup interface, implemented over PostgreSQL
// (src/db/crm.ts) and in memory from the seed file (src/pipeline/crm-memory.ts), so the
// dataset-wide test runs without a database. A change to the rules is a new ENRICHER_VERSION.

import type { IdentifierType, ServiceType } from "../taxonomy.js";

export const ENRICHER_VERSION = "enrich.v1";

/** The account keys used for lookup. Birth numbers, bank accounts and IBANs are not. */
export const LOOKUP_KEY_TYPES = ["customer_number", "contract_number", "phone", "email"] as const;
export type LookupKeyType = (typeof LOOKUP_KEY_TYPES)[number];

export const ENRICHMENT_OUTCOMES = ["found", "not_found", "ambiguous", "no_identifiers"] as const;
export type EnrichmentOutcome = (typeof ENRICHMENT_OUTCOMES)[number];

export const AREA_SOURCES = ["message", "customer"] as const;
export type AreaSource = (typeof AREA_SOURCES)[number];

/** Service types a CRM service or an outage can have (no "unknown"). */
export const CRM_SERVICE_TYPES = ["internet", "mobile", "tv"] as const;
export type CrmServiceType = (typeof CRM_SERVICE_TYPES)[number];

export const SERVICE_STATUSES = ["active", "terminated"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/** What enrichment needs to know about a customer's service. */
export interface ServiceSummary {
  serviceType: CrmServiceType;
  area: string;
  status: ServiceStatus;
}

export interface CrmLookup {
  /** IDs of the customers the key belongs to; `key` is already `lookupKey(type, value)`. */
  customersByKey(type: LookupKeyType, key: string): Promise<string[]>;
  servicesOfCustomer(customerId: string): Promise<ServiceSummary[]>;
  /** IDs of the outages in `area` (compared with `normalizeArea`) of `serviceType` (any when null) at `at`. */
  outagesAt(area: string, serviceType: CrmServiceType | null, at: Date): Promise<string[]>;
}

export function isLookupKeyType(type: IdentifierType): type is LookupKeyType {
  return (LOOKUP_KEY_TYPES as readonly string[]).includes(type);
}

/**
 * The value a key is compared by, on both sides of the lookup.
 * Phones compare by their last 9 digits: the masker keeps "+420" only when it was written, so
 * "777 123 456" and "+420 777 123 456" must be the same number.
 */
export function lookupKey(type: LookupKeyType, value: string): string {
  if (type === "phone") return value.replace(/\D/g, "").slice(-9);
  const compact = value.replace(/\s+/g, "");
  return type === "email" ? compact.toLowerCase() : compact.toUpperCase();
}

/** Areas compare ignoring case, diacritics and extra spaces, as in the labelling guide. */
export function normalizeArea(area: string): string {
  return area
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** An outage covers `at` when it started at or before it and wasn't resolved yet. */
export function outageCovers(outage: { startedAt: Date; resolvedAt: Date | null }, at: Date): boolean {
  return outage.startedAt <= at && (outage.resolvedAt === null || at < outage.resolvedAt);
}

export interface EnrichInput {
  /** The masking map (P05). Only the account keys are used. */
  identifiers: readonly { placeholder: string; type: IdentifierType; normalizedValue: string }[];
  /** From the classification; null when the message names none. */
  area: string | null;
  serviceType: ServiceType;
  receivedAt: Date;
}

export interface Candidate {
  customerId: string;
  /** Placeholders that matched this customer, in text order. */
  placeholders: string[];
}

export interface EnrichmentResult {
  outcome: EnrichmentOutcome;
  /** Set exactly when the outcome is `found`. */
  customerId: string | null;
  candidates: Candidate[];
  unmatchedPlaceholders: string[];
  area: string | null;
  areaSource: AreaSource | null;
  /** Sorted. */
  outageIds: string[];
}

function knownServiceType(serviceType: ServiceType): CrmServiceType | null {
  return serviceType === "unknown" ? null : serviceType;
}

/**
 * The area of a found customer's services: those of the classified service type when it is
 * known and the customer has any, otherwise all; active ones preferred. Used only when all of
 * them are in one area, so a customer with services in two towns gives no area.
 */
async function customerArea(crm: CrmLookup, customerId: string, serviceType: ServiceType): Promise<string | null> {
  const services = await crm.servicesOfCustomer(customerId);
  const type = knownServiceType(serviceType);
  const ofType = type ? services.filter((s) => s.serviceType === type) : [];
  const relevant = ofType.length > 0 ? ofType : services;
  const active = relevant.filter((s) => s.status === "active");
  const chosen = active.length > 0 ? active : relevant;
  const areas = new Set(chosen.map((s) => normalizeArea(s.area)));
  return areas.size === 1 ? chosen[0]!.area : null;
}

export async function enrich(input: EnrichInput, crm: CrmLookup): Promise<EnrichmentResult> {
  const keys = input.identifiers.filter((i): i is EnrichInput["identifiers"][number] & { type: LookupKeyType } =>
    isLookupKeyType(i.type),
  );

  // Map keeps insertion order: candidates come out in the order their first key appears.
  const byCustomer = new Map<string, string[]>();
  const unmatchedPlaceholders: string[] = [];
  for (const key of keys) {
    const customerIds = [...new Set(await crm.customersByKey(key.type, lookupKey(key.type, key.normalizedValue)))];
    if (customerIds.length === 0) unmatchedPlaceholders.push(key.placeholder);
    for (const id of customerIds.sort()) {
      const placeholders = byCustomer.get(id) ?? [];
      placeholders.push(key.placeholder);
      byCustomer.set(id, placeholders);
    }
  }
  const candidates = [...byCustomer].map(([customerId, placeholders]) => ({ customerId, placeholders }));

  const outcome: EnrichmentOutcome =
    keys.length === 0
      ? "no_identifiers"
      : candidates.length === 0
        ? "not_found"
        : candidates.length === 1
          ? "found"
          : "ambiguous";
  const customerId = outcome === "found" ? candidates[0]!.customerId : null;

  let area = input.area?.trim() || null;
  let areaSource: AreaSource | null = area ? "message" : null;
  if (!area && customerId) {
    area = await customerArea(crm, customerId, input.serviceType);
    areaSource = area ? "customer" : null;
  }
  const outageIds = area
    ? [...new Set(await crm.outagesAt(area, knownServiceType(input.serviceType), input.receivedAt))].sort()
    : [];

  return { outcome, customerId, candidates, unmatchedPlaceholders, area, areaSource, outageIds };
}
