// The fictional provider. The name was checked against the web and the Czech
// business register (ARES) on 2026-11-18 with no matching company; see
// eval/labelling-guide.md. All tariff names below are invented.

export const COMPANY = {
  name: "Merelo",
  legalName: "Merelo a.s.",
  website: "merelo.example",
  supportEmail: "podpora@merelo.example",
  countries: ["CZ", "SK"],
} as const;

export const SERVICES = {
  internet: [
    { name: "Merelo Fiber 300", technology: "fibre" },
    { name: "Merelo Fiber 1000", technology: "fibre" },
    { name: "Merelo DSL 50", technology: "dsl" },
    { name: "Merelo Home 5G", technology: "fixed wireless" },
  ],
  mobile: [
    { name: "Merelo Mobil S", data: "5 GB" },
    { name: "Merelo Mobil M", data: "20 GB" },
    { name: "Merelo Mobil Neomezeně", data: "unlimited" },
    { name: "Merelo Data Only 50", data: "50 GB" },
  ],
  tv: [
    { name: "Merelo TV Start", channels: 60 },
    { name: "Merelo TV Plus", channels: 140 },
  ],
} as const;

/** Prefixes of the company's own identifiers (formats in eval/labelling-guide.md). */
export const IDENTIFIER_PREFIXES = {
  customerNumber: "MR",
  contractNumber: "SML-",
} as const;

/** Towns and districts served. Real place names; places are not companies or people. */
export const AREAS = {
  CZ: [
    "Praha 4",
    "Praha 10",
    "Brno-Žabovřesky",
    "Ostrava-Poruba",
    "Plzeň",
    "Olomouc",
    "Liberec",
    "České Budějovice",
    "Hradec Králové",
    "Pardubice",
    "Zlín",
    "Jihlava",
    "Kolín",
    "Tábor",
    "Kladno",
    "Opava",
  ],
  SK: ["Bratislava-Petržalka", "Košice", "Žilina", "Nitra", "Trnava", "Banská Bystrica", "Prešov"],
} as const;
