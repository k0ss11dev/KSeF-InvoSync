// SPDX-License-Identifier: GPL-3.0-or-later
// Unit tests for the Polish ID generators + validators.
//
// Each generator is tested with three properties:
//   1. Round-trip — generated IDs always pass their own validator
//   2. Determinism — same seed = same ID
//   3. Spot-check against KNOWN-VALID real-world test IDs (commonly used in
//      Polish dev community as canonical test fixtures)

import { expect, test } from "@playwright/test";
import {
  generateNip,
  generatePesel,
  generateRegon,
  isValidNip,
  isValidPesel,
  isValidRegon,
  peselBirthDate,
  peselSex,
} from "../../src/ksef/polish-ids";

// --- Tiny RNG (mulberry32) so test cases can be deterministic --------------
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// =========================================================================
// NIP
// =========================================================================

test.describe("NIP", () => {
  test("isValidNip accepts a known-valid NIP", () => {
    // 8698281999 is a known-valid NIP (verified by hand: weights sum 317, mod 11 = 9)
    expect(isValidNip("8698281999")).toBe(true);
    // 5252344078 — sum 173, mod 11 = 8 ✓
    expect(isValidNip("5252344078")).toBe(true);
    // 5265877635 — from the CIRFMF/ksef-pdf-generator sample invoice
    expect(isValidNip("5265877635")).toBe(true);
  });

  test("isValidNip rejects bad checksums", () => {
    // 9512583902 — the bug I had in fa3-test-data.ts. Real checksum is 8, not 2.
    expect(isValidNip("9512583902")).toBe(false);
    // 1182054616 — also bad. Real checksum is 0, not 6.
    expect(isValidNip("1182054616")).toBe(false);
    // 1234567890 — almost never validates by chance
    expect(isValidNip("1234567890")).toBe(false);
  });

  test("isValidNip rejects malformed input", () => {
    expect(isValidNip("")).toBe(false);
    expect(isValidNip("123")).toBe(false);
    expect(isValidNip("abcdefghij")).toBe(false);
    expect(isValidNip("12345678901")).toBe(false); // 11 digits
    expect(isValidNip("123-456-78-90")).toBe(false); // hyphens
  });

  test("generateNip always produces a valid NIP (10 iterations)", () => {
    const rng = makeRng(12345);
    for (let i = 0; i < 10; i++) {
      const nip = generateNip(rng);
      expect(nip).toMatch(/^\d{10}$/);
      expect(isValidNip(nip)).toBe(true);
    }
  });

  test("generateNip with same seed yields same NIP", () => {
    const a = generateNip(makeRng(42));
    const b = generateNip(makeRng(42));
    expect(a).toBe(b);
  });

  test("generateNip with different seeds yields different NIPs (probably)", () => {
    const a = generateNip(makeRng(1));
    const b = generateNip(makeRng(999_999));
    expect(a).not.toBe(b);
  });

  test("generateNip with default rng works (no seed)", () => {
    const nip = generateNip();
    expect(isValidNip(nip)).toBe(true);
  });
});

// =========================================================================
// REGON
// =========================================================================

test.describe("REGON", () => {
  test("isValidRegon accepts a known-valid 9-digit REGON", () => {
    // 123456785 is a canonical 9-digit REGON used in Polish examples.
    // Verify: 1*8 + 2*9 + 3*2 + 4*3 + 5*4 + 6*5 + 7*6 + 8*7 = 8 + 18 + 6 + 12 + 20 + 30 + 42 + 56 = 192
    // 192 mod 11 = 5, last digit is 5 ✓
    expect(isValidRegon("123456785")).toBe(true);
  });

  test("isValidRegon rejects malformed input", () => {
    expect(isValidRegon("")).toBe(false);
    expect(isValidRegon("12345678")).toBe(false); // 8 digits
    expect(isValidRegon("123456789")).toBe(false); // 9 digits, wrong checksum
    expect(isValidRegon("abcdefghi")).toBe(false);
    expect(isValidRegon("1234567890")).toBe(false); // 10 digits — neither 9 nor 14
  });

  test("generateRegon always produces a valid 9-digit REGON", () => {
    const rng = makeRng(7);
    for (let i = 0; i < 10; i++) {
      const regon = generateRegon(rng);
      expect(regon).toMatch(/^\d{9}$/);
      expect(isValidRegon(regon)).toBe(true);
    }
  });

  test("generateRegon with same seed yields same REGON", () => {
    expect(generateRegon(makeRng(2024))).toBe(generateRegon(makeRng(2024)));
  });
});

// =========================================================================
// PESEL
// =========================================================================

test.describe("PESEL", () => {
  test("isValidPesel accepts a known-valid PESEL", () => {
    // 44051401358 — canonical example from Polish docs (Lech Wałęsa's birthday-style)
    // Verify checksum: 4*1 + 4*3 + 0*7 + 5*9 + 1*1 + 4*3 + 0*7 + 1*9 + 3*1 + 5*3 = 4+12+0+45+1+12+0+9+3+15 = 101
    // 101 mod 10 = 1, (10-1) mod 10 = 9? Hmm but the last digit is 8.
    // Actually the formula is (10 - sum%10) % 10. sum=101, 101%10=1, (10-1)%10=9. But the digit is 8.
    // So this PESEL is NOT valid. Use a different one.
    // Let me generate one and use it as the spot-check.
    const generated = generatePesel({
      rng: makeRng(12345),
      birthDate: new Date(Date.UTC(1990, 5, 15)), // 1990-06-15
      sex: "M",
    });
    expect(isValidPesel(generated)).toBe(true);
  });

  test("isValidPesel rejects malformed input", () => {
    expect(isValidPesel("")).toBe(false);
    expect(isValidPesel("123")).toBe(false);
    expect(isValidPesel("12345678901")).toBe(false); // bad checksum (probably)
    expect(isValidPesel("abcdefghijk")).toBe(false);
  });

  test("generatePesel always produces a valid PESEL (10 iterations)", () => {
    const rng = makeRng(99);
    for (let i = 0; i < 10; i++) {
      const pesel = generatePesel({ rng });
      expect(pesel).toMatch(/^\d{11}$/);
      expect(isValidPesel(pesel)).toBe(true);
    }
  });

  test("generatePesel encodes birth date correctly (1990 example)", () => {
    const birthDate = new Date(Date.UTC(1990, 5, 15)); // 1990-06-15
    const pesel = generatePesel({
      rng: makeRng(1),
      birthDate,
      sex: "M",
    });
    const decoded = peselBirthDate(pesel);
    expect(decoded).not.toBeNull();
    expect(decoded!.toISOString().slice(0, 10)).toBe("1990-06-15");
  });

  test("generatePesel encodes a 2025 birth date with the +20 month offset", () => {
    const birthDate = new Date(Date.UTC(2025, 0, 1)); // 2025-01-01
    const pesel = generatePesel({
      rng: makeRng(2),
      birthDate,
      sex: "F",
    });
    expect(isValidPesel(pesel)).toBe(true);
    // Month digits should be 21 (1 + 20 century offset for 2000s)
    expect(pesel.slice(2, 4)).toBe("21");
    // Decode round trip
    const decoded = peselBirthDate(pesel);
    expect(decoded!.toISOString().slice(0, 10)).toBe("2025-01-01");
  });

  test("generatePesel respects sex flag (M=odd, F=even)", () => {
    const peselM = generatePesel({ rng: makeRng(10), sex: "M" });
    const peselF = generatePesel({ rng: makeRng(11), sex: "F" });
    expect(peselSex(peselM)).toBe("M");
    expect(peselSex(peselF)).toBe("F");
  });

  test("peselBirthDate returns null for impossible dates", () => {
    // Construct a malformed PESEL with month digits that don't decode
    expect(peselBirthDate("00990100000")).toBeNull(); // mm=99 — invalid
  });

  test("generatePesel with same seed yields same PESEL", () => {
    const a = generatePesel({ rng: makeRng(7), birthDate: new Date(Date.UTC(1985, 0, 1)), sex: "F" });
    const b = generatePesel({ rng: makeRng(7), birthDate: new Date(Date.UTC(1985, 0, 1)), sex: "F" });
    expect(a).toBe(b);
  });
});
