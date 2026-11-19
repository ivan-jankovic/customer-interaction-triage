// The rule-based masker (P05 requirements.md, "Masking rules"): every type and format,
// overlaps, boundaries, repeats and the things it must leave alone.

import { describe, expect, it } from "vitest";
import { isPlausibleBirthDate, mask, MASKER_VERSION } from "../../src/pipeline/mask.js";

/** The masked text and the (type, value) pairs, for compact assertions. */
function m(text: string) {
  const r = mask(text);
  return { text: r.maskedText, ids: r.identifiers.map((i) => [i.type, i.value]) };
}

describe("mask: each type and format", () => {
  it.each([
    ["Volejte +420 777 123 456 prosím", "Volejte [PHONE_1] prosím", "+420 777 123 456"],
    ["tel. +420777123456.", "tel. [PHONE_1].", "+420777123456"],
    ["+421 905 123 456", "[PHONE_1]", "+421 905 123 456"],
    ["00420 603 111 222", "[PHONE_1]", "00420 603 111 222"],
    ["00421905123456", "[PHONE_1]", "00421905123456"],
    ["+420 040770154", "[PHONE_1]", "+420 040770154"],
    ["moje číslo je 777 123 456", "moje číslo je [PHONE_1]", "777 123 456"],
    ["moje číslo je 777123456", "moje číslo je [PHONE_1]", "777123456"],
  ])("phone: %s", (text, masked, value) => {
    expect(m(text)).toEqual({ text: masked, ids: [["phone", value]] });
  });

  it.each([
    ["Pište na jana.k82@example.com.", "Pište na [EMAIL_1].", "jana.k82@example.com"],
    ["mail: Petr_N+test@sub.example.org", "mail: [EMAIL_1]", "Petr_N+test@sub.example.org"],
  ])("email: %s", (text, masked, value) => {
    expect(m(text)).toEqual({ text: masked, ids: [["email", value]] });
  });

  it.each([
    ["IBAN CZ12 0042 1234 5678 9012 3456, díky", "IBAN [IBAN_1], díky", "CZ12 0042 1234 5678 9012 3456"],
    ["SK6400112527928343658041", "[IBAN_1]", "SK6400112527928343658041"],
  ])("iban: %s", (text, masked, value) => {
    expect(m(text)).toEqual({ text: masked, ids: [["iban", value]] });
  });

  it("customer and contract numbers", () => {
    expect(m("Zákazník MR40218837, smlouva SML-2023-04417.")).toEqual({
      text: "Zákazník [CUSTOMER_NUMBER_1], smlouva [CONTRACT_NUMBER_1].",
      ids: [
        ["customer_number", "MR40218837"],
        ["contract_number", "SML-2023-04417"],
      ],
    });
  });

  it.each([
    ["rodné číslo 855412/3318", "855412/3318"], // woman: month 54 = April
    ["RČ 640101/123", "640101/123"], // 9-digit form, born before 1954
    ["835212/3318", "835212/3318"],
  ])("birth number: %s", (text, value) => {
    expect(m(text).ids).toEqual([["birth_number", value]]);
  });

  it.each([
    ["účet 2738110453/0042", "2738110453/0042"],
    ["účet 19-2000145399/0800", "19-2000145399/0800"],
    // 6 digits that are not a date (month 13) are an account, not a birth number.
    ["účet 851399/0100", "851399/0100"],
  ])("bank account: %s", (text, value) => {
    expect(m(text).ids).toEqual([["bank_account", value]]);
  });
});

describe("mask: what must stay", () => {
  it.each([
    ["Merelo's own address", "Napište na podpora@merelo.example nebo info@ops.merelo.example."],
    ["a month and year", "Faktura za 10/2025 je vyšší."],
    ["an amount", "Zaplatil jsem 1 234 Kč a 12 345,50 Kč."],
    ["a large spaced amount", "Ztráta 1 234 567 890 Kč."],
    ["a date and a time", "Dne 18. 11. 2026 v 14:30, tedy 2026-11-18."],
    ["a postcode", "Bydlím v Praze 4, PSČ 140 00."],
    ["a digit run longer than a phone", "Kód 1234567890123 nefunguje."],
    ["a tariff name with a number", "Mám Merelo Fiber 1000 a Mobil M."],
    ["text with no identifiers", "Dobrý den, nejde mi internet."],
  ])("leaves %s alone", (_case, text) => {
    expect(m(text)).toEqual({ text, ids: [] });
  });

  it("doesn't turn an IBAN's digit groups into a phone or an account", () => {
    expect(m("CZ65 0800 0000 1920 0014 5399").ids).toEqual([["iban", "CZ65 0800 0000 1920 0014 5399"]]);
  });
});

describe("mask: placeholders and mapping", () => {
  it("numbers per type in order of appearance and reuses a placeholder for the same value", () => {
    const r = mask("Volal jsem z +420 777 111 222, pak z 777 333 444 a znovu z +420777111222. Mail a1@example.com.");
    expect(r.maskedText).toBe("Volal jsem z [PHONE_1], pak z [PHONE_2] a znovu z [PHONE_1]. Mail [EMAIL_1].");
    expect(r.identifiers.map((i) => [i.placeholder, i.normalizedValue])).toEqual([
      ["[PHONE_1]", "+420777111222"],
      ["[PHONE_2]", "777333444"],
      ["[EMAIL_1]", "a1@example.com"],
    ]);
  });

  it("treats e-mails case-insensitively and keeps the first spelling", () => {
    const r = mask("Jana.K@Example.com a jana.k@example.com");
    expect(r.maskedText).toBe("[EMAIL_1] a [EMAIL_1]");
    expect(r.identifiers).toHaveLength(1);
    expect(r.identifiers[0]).toMatchObject({ value: "Jana.K@Example.com", normalizedValue: "jana.k@example.com" });
  });

  it("records offsets of the first occurrence in the original text", () => {
    const text = "Číslo MR12345678 a SML-2024-00001.";
    for (const id of mask(text).identifiers) expect(text.slice(id.start, id.end)).toBe(id.value);
  });

  it("is deterministic and versioned", () => {
    const text = "MR12345678, +420 777 123 456";
    expect(mask(text)).toEqual(mask(text));
    expect(MASKER_VERSION).toBe("mask.v1");
  });
});

describe("isPlausibleBirthDate", () => {
  it.each([
    ["850412", true],
    ["855412", true], // woman
    ["852412", true], // extended range (+20)
    ["857412", true], // woman, extended range
    ["851312", false],
    ["850400", false],
    ["850432", false],
  ])("%s → %s", (yymmdd, ok) => {
    expect(isPlausibleBirthDate(yymmdd)).toBe(ok);
  });
});
