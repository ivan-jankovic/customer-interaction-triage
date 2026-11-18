import { describe, expect, it } from "vitest";
import { IDENTIFIER_TYPES } from "../../src/taxonomy.js";
import {
  IDENTIFIER_PATTERNS,
  generateIdentifier,
  isValidBirthNumberChecksum,
  isValidCzAccountChecksum,
  isValidIban,
} from "../../eval/dataset/identifiers.js";
import { createRng } from "../../eval/lib/rng.js";

describe("fictional identifiers", () => {
  it("is deterministic for a seed", () => {
    const a = generateIdentifier(createRng(7), "iban", "cs");
    const b = generateIdentifier(createRng(7), "iban", "cs");
    expect(a).toEqual(b);
  });

  it("matches the documented format for every type and language", () => {
    const rng = createRng(42);
    for (const type of IDENTIFIER_TYPES) {
      for (const language of ["cs", "sk", "en"] as const) {
        for (let i = 0; i < 50; i++) {
          const { value } = generateIdentifier(rng, type, language);
          expect(value, `${type}: ${value}`).toMatch(IDENTIFIER_PATTERNS[type]);
        }
      }
    }
  });

  it("generates invalid checksums where the guide says so", () => {
    const rng = createRng(1);
    for (let i = 0; i < 200; i++) {
      expect(isValidBirthNumberChecksum(generateIdentifier(rng, "birth_number", "cs").value)).toBe(false);
      const account = generateIdentifier(rng, "bank_account", "cs").value.split("/")[0]!;
      expect(isValidCzAccountChecksum(account)).toBe(false);
      expect(isValidIban(generateIdentifier(rng, "iban", "sk").value)).toBe(false);
    }
  });

  it("recognises valid checksums (sanity check of the validators)", () => {
    expect(isValidIban("CZ65 0800 0000 1920 0014 5399")).toBe(true); // ISO example
    // 7801010000 + k, chosen so the 10-digit number is divisible by 11.
    const base = 7801010000n;
    const valid = String(base + ((11n - (base % 11n)) % 11n));
    expect(isValidBirthNumberChecksum(valid)).toBe(true);
    expect(isValidBirthNumberChecksum(String(BigInt(valid) + 1n))).toBe(false);
    // Weights 2 and 1 on the last two digits: 1*2 + 9*1 = 11.
    expect(isValidCzAccountChecksum("19")).toBe(true);
    expect(isValidCzAccountChecksum("18")).toBe(false);
  });

  it("uses phone numbers that no numbering plan assigns (national part starts with 0)", () => {
    const rng = createRng(3);
    for (let i = 0; i < 50; i++) {
      const value = generateIdentifier(rng, "phone", "sk").value.replace(/\s/g, "");
      expect(value).toMatch(/^\+4210/);
    }
  });
});
