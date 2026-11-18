// Fictional personal identifiers, generated in code (never by the model) so that
// labels know exactly what each message contains and nothing can match a real person.
// Formats and the reasoning behind each "cannot be real" choice are documented in
// eval/labelling-guide.md ("Identifier formats").

import { IDENTIFIER_PREFIXES } from "../../src/company.js";
import type { IdentifierType, Language } from "../../src/taxonomy.js";
import type { Rng } from "../lib/rng.js";

export interface Identifier {
  type: IdentifierType;
  value: string;
}

const digits = (rng: Rng, n: number): string => Array.from({ length: n }, () => String(rng.int(0, 9))).join("");

/** MR + 8 digits, e.g. MR40218837. */
export function customerNumber(rng: Rng): string {
  return `${IDENTIFIER_PREFIXES.customerNumber}${rng.int(1, 9)}${digits(rng, 7)}`;
}

/** SML-YYYY-NNNNN, e.g. SML-2023-04417. */
export function contractNumber(rng: Rng): string {
  return `${IDENTIFIER_PREFIXES.contractNumber}${rng.int(2018, 2026)}-${digits(rng, 5)}`;
}

/**
 * +420 / +421 followed by a national number starting with 0. Neither numbering plan
 * assigns national numbers starting with 0, so these cannot reach a real subscriber.
 */
export function phone(rng: Rng, language: Language): string {
  const country = language === "sk" ? "+421" : "+420";
  const national = `0${digits(rng, 8)}`;
  const style = rng.int(0, 2);
  if (style === 0) return `${country} ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
  if (style === 1) return `${country}${national}`;
  return `${country} ${national}`;
}

const MAIL_HANDLES = ["jana", "petr", "lucie", "martin", "eva", "tomas", "katka", "jozef", "zuzana", "honza", "anna", "milan"];
// RFC 2606 reserved domains, plus the company's own reserved-TLD domain is never used for customers.
export const RESERVED_MAIL_DOMAINS = ["example.com", "example.net", "example.org"] as const;

export function email(rng: Rng): string {
  const handle = rng.pick(MAIL_HANDLES);
  const sep = rng.pick([".", "_", ""]);
  return `${handle}${sep}${rng.pick(["k", "n", "s", "d", "h", "m"])}${rng.int(10, 99)}@${rng.pick(RESERVED_MAIL_DOMAINS)}`;
}

/** Valid Czech/Slovak birth number checksum: 10-digit number divisible by 11 (or the old mod-10 exception). */
export function isValidBirthNumberChecksum(value: string): boolean {
  const d = value.replace("/", "");
  if (d.length !== 10) return false;
  const n = BigInt(d);
  if (n % 11n === 0n) return true;
  const firstNine = BigInt(d.slice(0, 9));
  return firstNine % 11n === 10n && d.endsWith("0");
}

/** YYMMDD/XXXX with a plausible date and a deliberately invalid checksum. */
export function birthNumber(rng: Rng): string {
  for (;;) {
    const year = rng.int(55, 99);
    const female = rng.chance(0.5);
    const month = rng.int(1, 12) + (female ? 50 : 0);
    const day = rng.int(1, 28);
    const value = `${String(year).padStart(2, "0")}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}/${digits(rng, 4)}`;
    if (!isValidBirthNumberChecksum(value)) return value;
  }
}

const ACCOUNT_WEIGHTS = [6, 3, 7, 9, 10, 5, 8, 4, 2, 1];

/** Czech account-number checksum (weighted mod 11) for the 10-digit main part. */
export function isValidCzAccountChecksum(accountDigits: string): boolean {
  const padded = accountDigits.padStart(10, "0");
  const sum = [...padded].reduce((acc, ch, i) => acc + Number(ch) * ACCOUNT_WEIGHTS[i]!, 0);
  return sum % 11 === 0;
}

/** Bank codes 0001–0099: below the lowest code in use (0100), so no real bank. */
const bankCode = (rng: Rng): string => `00${String(rng.int(1, 99)).padStart(2, "0")}`;

/** number/bankcode with an invalid account checksum, e.g. 2738110453/0042. */
export function bankAccount(rng: Rng): string {
  for (;;) {
    const number = `${rng.int(1, 9)}${digits(rng, 9)}`;
    if (!isValidCzAccountChecksum(number)) return `${number}/${bankCode(rng)}`;
  }
}

/** ISO 13616 mod-97 check. */
export function isValidIban(iban: string): boolean {
  const compact = iban.replace(/\s+/g, "").toUpperCase();
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  const numeric = [...rearranged].map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c)).join("");
  let remainder = 0;
  for (const ch of numeric) remainder = (remainder * 10 + Number(ch)) % 97;
  return remainder === 1;
}

/** CZ/SK IBAN (24 chars) with an invalid check, grouped in fours. */
export function iban(rng: Rng, language: Language): string {
  const country = language === "sk" ? "SK" : "CZ";
  for (;;) {
    const raw = `${country}${digits(rng, 2)}${bankCode(rng)}${digits(rng, 16)}`;
    if (!isValidIban(raw)) return raw.match(/.{1,4}/g)!.join(" ");
  }
}

export function generateIdentifier(rng: Rng, type: IdentifierType, language: Language): Identifier {
  switch (type) {
    case "customer_number":
      return { type, value: customerNumber(rng) };
    case "contract_number":
      return { type, value: contractNumber(rng) };
    case "phone":
      return { type, value: phone(rng, language) };
    case "email":
      return { type, value: email(rng) };
    case "birth_number":
      return { type, value: birthNumber(rng) };
    case "bank_account":
      return { type, value: bankAccount(rng) };
    case "iban":
      return { type, value: iban(rng, language) };
  }
}

/** Patterns the synthetic-data guard uses to recognise each type in message text. */
export const IDENTIFIER_PATTERNS: Readonly<Record<IdentifierType, RegExp>> = {
  customer_number: /^MR[1-9]\d{7}$/,
  contract_number: /^SML-20\d{2}-\d{5}$/,
  phone: /^\+42[01] ?0\d{2} ?\d{3} ?\d{3}$/,
  email: /^[a-z]+[._]?[a-z]\d{2}@example\.(com|net|org)$/,
  birth_number: /^\d{6}\/\d{4}$/,
  bank_account: /^[1-9]\d{9}\/00\d{2}$/,
  iban: /^(CZ|SK)\d{2} 00\d{2}( \d{4}){4}$/,
};
