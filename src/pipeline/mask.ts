// Step 2 of the pipeline: rule-based masking (P05 requirements.md, "Masking rules").
// Replaces the seven identifier types with typed placeholders such as [PHONE_1] before
// anything is sent to a model, and returns the mapping (used by P06's CRM lookup).
//
// Recognition is by format only. Checksums are not checked: the dataset's identifiers are
// built to fail them (labelling guide, "Identifier formats"), and real input has typos.
// Pure and deterministic; a change to the rules is a new MASKER_VERSION.

import type { IdentifierType } from "../taxonomy.js";

export const MASKER_VERSION = "mask.v1";

export interface MaskedIdentifier {
  placeholder: string;
  type: IdentifierType;
  /** As first written in the text. */
  value: string;
  /** Without spaces; lower case for e-mails, upper case otherwise. Equal values share a placeholder. */
  normalizedValue: string;
  /** Offsets of the first occurrence in the original text. */
  start: number;
  end: number;
}

export interface MaskResult {
  maskedText: string;
  /** In order of first appearance in the text. */
  identifiers: MaskedIdentifier[];
}

const PLACEHOLDER_NAME: Readonly<Record<IdentifierType, string>> = {
  iban: "IBAN",
  email: "EMAIL",
  customer_number: "CUSTOMER_NUMBER",
  contract_number: "CONTRACT_NUMBER",
  birth_number: "BIRTH_NUMBER",
  bank_account: "BANK_ACCOUNT",
  phone: "PHONE",
};

/** A plausible YYMMDD of a Czech/Slovak birth number (women: month + 50; extended ranges + 20). */
export function isPlausibleBirthDate(yymmdd: string): boolean {
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  const monthOk = [0, 20, 50, 70].some((offset) => month - offset >= 1 && month - offset <= 12);
  return monthOk && day >= 1 && day <= 31;
}

interface Rule {
  type: IdentifierType;
  pattern: RegExp;
  accept?: (match: string) => boolean;
}

/**
 * Matched in this order; a span already taken is never matched again (an IBAN's digit groups
 * can't become a phone number). Every pattern has explicit boundaries, so a match never starts
 * or ends inside a longer run of digits or letters.
 */
const RULES: readonly Rule[] = [
  // CZ/SK IBAN: country, 2 check digits, 20 digits; spaces allowed after every 4 characters.
  { type: "iban", pattern: /(?<![A-Za-z0-9])(?:CZ|SK)\d{2}(?: ?\d{4}){5}(?![A-Za-z0-9])/gi },
  {
    type: "email",
    pattern: /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g,
    // Merelo's own addresses are not personal data.
    accept: (m) => !/@(?:[\w-]+\.)*merelo\.example$/i.test(m),
  },
  { type: "customer_number", pattern: /(?<![A-Za-z0-9])MR\d{8}(?![A-Za-z0-9])/gi },
  { type: "contract_number", pattern: /(?<![A-Za-z0-9])SML-\d{4}-\d{5}(?![A-Za-z0-9])/gi },
  {
    type: "birth_number",
    pattern: /(?<![\d/-])\d{6}\/\d{3,4}(?![\d/])/g,
    accept: (m) => isPlausibleBirthDate(m.slice(0, 6)),
  },
  // Optional prefix, then 5–10 digits, "/" and a 4-digit bank code. The base needs at least 5
  // digits so that a month/year such as "10/2025" is not taken for an account.
  { type: "bank_account", pattern: /(?<![\d/-])(?:\d{1,6}-)?\d{5,10}\/\d{4}(?![\d/])/g },
  // International: +420, +421, 00420 or 00421, then 9 digits with optional single spaces.
  { type: "phone", pattern: /(?<![\d+])(?:\+|00)42[01] ?(?:\d ?){8}\d(?!\d)/g },
  // National: 9 digits as one block or in groups of 3, not part of a longer spaced number.
  { type: "phone", pattern: /(?<![\d+/.,-])(?<!\d )(?:\d{3} \d{3} \d{3}|\d{9})(?![\d/.,-])(?! \d)/g },
];

function normalize(type: IdentifierType, value: string): string {
  const compact = value.replace(/\s+/g, "");
  return type === "email" ? compact.toLowerCase() : compact.toUpperCase();
}

export function mask(text: string): MaskResult {
  const taken: { start: number; end: number; type: IdentifierType; value: string }[] = [];
  const overlaps = (start: number, end: number) => taken.some((t) => start < t.end && end > t.start);

  for (const rule of RULES) {
    for (const m of text.matchAll(rule.pattern)) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end) || (rule.accept && !rule.accept(m[0]))) continue;
      taken.push({ start, end, type: rule.type, value: m[0] });
    }
  }
  taken.sort((a, b) => a.start - b.start);

  // Number per type in order of first appearance; the same normalised value reuses its placeholder.
  const identifiers: MaskedIdentifier[] = [];
  const byKey = new Map<string, MaskedIdentifier>();
  const counters = new Map<IdentifierType, number>();
  const placeholders = taken.map((t) => {
    const normalizedValue = normalize(t.type, t.value);
    const key = `${t.type}\u0000${normalizedValue}`;
    let entry = byKey.get(key);
    if (!entry) {
      const n = (counters.get(t.type) ?? 0) + 1;
      counters.set(t.type, n);
      entry = {
        placeholder: `[${PLACEHOLDER_NAME[t.type]}_${n}]`,
        type: t.type,
        value: t.value,
        normalizedValue,
        start: t.start,
        end: t.end,
      };
      byKey.set(key, entry);
      identifiers.push(entry);
    }
    return entry.placeholder;
  });

  let maskedText = "";
  let cursor = 0;
  taken.forEach((t, i) => {
    maskedText += text.slice(cursor, t.start) + placeholders[i]!;
    cursor = t.end;
  });
  maskedText += text.slice(cursor);
  return { maskedText, identifiers };
}
