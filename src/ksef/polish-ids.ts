// SPDX-License-Identifier: GPL-3.0-or-later
// Algorithmically-correct generators and validators for the three Polish
// taxpayer identifiers we touch in this codebase:
//
//   NIP   (Numer Identyfikacji Podatkowej) — 10-digit business tax ID
//   REGON (Rejestr Gospodarki Narodowej)   — 9 or 14-digit business statistics ID
//   PESEL (Powszechny Elektroniczny System Ewidencji Ludności) — 11-digit personal ID
//
// All three have publicly-documented checksum algorithms. Without correct
// checksums, KSeF (and any other Polish tax/regulatory system) will reject
// the document at validation time. Hardcoding random-looking numbers in
// test fixtures usually produces 50-90% invalid checksums by chance.
//
// References:
//   NIP    — https://pl.wikipedia.org/wiki/Numer_identyfikacji_podatkowej
//   REGON  — https://pl.wikipedia.org/wiki/REGON
//   PESEL  — https://pl.wikipedia.org/wiki/PESEL
//
// All generators accept an optional `rng: () => number` (returning floats
// in [0, 1)) so the caller can plug in a deterministic PRNG (e.g. mulberry32
// from fa3-test-data.ts) and get reproducible IDs from a seed. With no rng,
// they fall back to Math.random.

// =========================================================================
// NIP (10 digits)
// =========================================================================
//
// Layout: 9 random digits + 1 checksum digit.
// Checksum:
//   weights = [6, 5, 7, 2, 3, 4, 5, 6, 7]
//   sum     = Σ digit[i] * weight[i]   (i = 0..8)
//   checksum = sum mod 11
//   If checksum == 10, the NIP is invalid (no representation) — regenerate.

const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7] as const;

export function isValidNip(nip: string): boolean {
  if (!/^\d{10}$/.test(nip)) return false;
  const digits = nip.split("").map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += digits[i] * NIP_WEIGHTS[i];
  const checksum = sum % 11;
  if (checksum === 10) return false;
  return checksum === digits[9];
}

export function generateNip(rng: () => number = Math.random): string {
  // Loop until we hit a base that has a valid checksum (<10). Worst case
  // ~10% rejection rate, in practice 1-2 iterations.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const digits: number[] = [];
    for (let i = 0; i < 9; i++) digits.push(Math.floor(rng() * 10));
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += digits[i] * NIP_WEIGHTS[i];
    const checksum = sum % 11;
    if (checksum < 10) {
      digits.push(checksum);
      return digits.join("");
    }
  }
}

// =========================================================================
// REGON (9 or 14 digits)
// =========================================================================
//
// Two variants in real life:
//   9-digit  — companies (most common)
//   14-digit — local / branch units of larger organizations
//
// 9-digit checksum:
//   weights = [8, 9, 2, 3, 4, 5, 6, 7]
//   sum mod 11; if 10, the checksum digit is 0 (note: this differs from NIP)
//
// 14-digit checksum:
//   First 9 digits validate as a 9-digit REGON.
//   weights = [2, 4, 8, 5, 0, 9, 7, 3, 6, 1, 2, 4, 8]
//   Same modulo / 10-rollover rule for the 14th digit.
//
// For test data we generate 9-digit REGONs.

const REGON_9_WEIGHTS = [8, 9, 2, 3, 4, 5, 6, 7] as const;
const REGON_14_WEIGHTS = [2, 4, 8, 5, 0, 9, 7, 3, 6, 1, 2, 4, 8] as const;

function regon9Checksum(digits: number[]): number {
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += digits[i] * REGON_9_WEIGHTS[i];
  const c = sum % 11;
  return c === 10 ? 0 : c;
}

function regon14Checksum(digits: number[]): number {
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += digits[i] * REGON_14_WEIGHTS[i];
  const c = sum % 11;
  return c === 10 ? 0 : c;
}

export function isValidRegon(regon: string): boolean {
  if (!/^\d{9}$|^\d{14}$/.test(regon)) return false;
  const digits = regon.split("").map(Number);
  if (digits.length === 9) {
    return regon9Checksum(digits) === digits[8];
  }
  // 14-digit REGON: first 9 must be a valid 9-digit REGON, then check the 14th.
  if (regon9Checksum(digits.slice(0, 9)) !== digits[8]) return false;
  return regon14Checksum(digits) === digits[13];
}

export function generateRegon(rng: () => number = Math.random): string {
  const digits: number[] = [];
  for (let i = 0; i < 8; i++) digits.push(Math.floor(rng() * 10));
  digits.push(regon9Checksum(digits));
  return digits.join("");
}

// =========================================================================
// PESEL (11 digits)
// =========================================================================
//
// Layout: YYMMDDPPPPK
//   YY     last 2 digits of birth year
//   MM     birth month, but encoded with century offset:
//             1800–1899 → +80 (so Jan 1850 → 81)
//             1900–1999 → +0
//             2000–2099 → +20
//             2100–2199 → +40
//             2200–2299 → +60
//   DD     birth day
//   PPPP   serial number; the 4th digit (10th overall) is the sex flag:
//             even = female, odd = male
//   K      checksum
//
// Checksum:
//   weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3]
//   sum mod 10, then K = (10 - result) mod 10

const PESEL_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3] as const;

export type PeselSex = "M" | "F";

export type GeneratePeselOpts = {
  rng?: () => number;
  /**
   * Date of birth as a JavaScript Date. Default: a random date in the
   * 1900-2099 range produced by the rng.
   */
  birthDate?: Date;
  /** Force a specific sex. Default: random. */
  sex?: PeselSex;
};

export function isValidPesel(pesel: string): boolean {
  if (!/^\d{11}$/.test(pesel)) return false;
  const digits = pesel.split("").map(Number);
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += digits[i] * PESEL_WEIGHTS[i];
  const checksum = (10 - (sum % 10)) % 10;
  return checksum === digits[10];
}

export function generatePesel(opts: GeneratePeselOpts = {}): string {
  const rng = opts.rng ?? Math.random;
  const sex: PeselSex = opts.sex ?? (rng() < 0.5 ? "F" : "M");

  const birthDate =
    opts.birthDate ?? randomBirthDate(rng);

  const year = birthDate.getUTCFullYear();
  const month = birthDate.getUTCMonth() + 1; // 1..12
  const day = birthDate.getUTCDate();

  // Century offset for the encoded month.
  let monthOffset: number;
  if (year >= 1800 && year <= 1899) monthOffset = 80;
  else if (year >= 1900 && year <= 1999) monthOffset = 0;
  else if (year >= 2000 && year <= 2099) monthOffset = 20;
  else if (year >= 2100 && year <= 2199) monthOffset = 40;
  else if (year >= 2200 && year <= 2299) monthOffset = 60;
  else throw new Error(`generatePesel: birth year ${year} is outside the supported PESEL range`);

  const yy = year % 100;
  const mm = month + monthOffset;

  const digits: number[] = [
    Math.floor(yy / 10),
    yy % 10,
    Math.floor(mm / 10),
    mm % 10,
    Math.floor(day / 10),
    day % 10,
  ];

  // Serial number — first 3 digits random, 4th digit encodes sex
  // (even = F, odd = M).
  digits.push(Math.floor(rng() * 10));
  digits.push(Math.floor(rng() * 10));
  digits.push(Math.floor(rng() * 10));
  const sexDigit = Math.floor(rng() * 5) * 2 + (sex === "M" ? 1 : 0);
  digits.push(sexDigit);

  // Checksum
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += digits[i] * PESEL_WEIGHTS[i];
  const checksum = (10 - (sum % 10)) % 10;
  digits.push(checksum);

  return digits.join("");
}

/**
 * Extract the encoded birth date from a PESEL. Returns null if the PESEL
 * is malformed or encodes an impossible date. Useful for round-trip tests.
 */
export function peselBirthDate(pesel: string): Date | null {
  if (!/^\d{11}$/.test(pesel)) return null;
  const yy = Number(pesel.slice(0, 2));
  const mmEncoded = Number(pesel.slice(2, 4));
  const dd = Number(pesel.slice(4, 6));

  let year: number;
  let month: number;
  if (mmEncoded >= 1 && mmEncoded <= 12) {
    year = 1900 + yy;
    month = mmEncoded;
  } else if (mmEncoded >= 21 && mmEncoded <= 32) {
    year = 2000 + yy;
    month = mmEncoded - 20;
  } else if (mmEncoded >= 41 && mmEncoded <= 52) {
    year = 2100 + yy;
    month = mmEncoded - 40;
  } else if (mmEncoded >= 61 && mmEncoded <= 72) {
    year = 2200 + yy;
    month = mmEncoded - 60;
  } else if (mmEncoded >= 81 && mmEncoded <= 92) {
    year = 1800 + yy;
    month = mmEncoded - 80;
  } else {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, dd));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== dd
  ) {
    return null; // e.g. Feb 30 was attempted
  }
  return date;
}

export function peselSex(pesel: string): PeselSex | null {
  if (!/^\d{11}$/.test(pesel)) return null;
  const sexDigit = Number(pesel[9]);
  return sexDigit % 2 === 0 ? "F" : "M";
}

// =========================================================================
// Helpers
// =========================================================================

function randomBirthDate(rng: () => number): Date {
  // Default to ages roughly 18-80 years old as of "today" — typical
  // adult population for test data.
  const now = Date.now();
  const minAgeMs = 18 * 365.25 * 24 * 3600 * 1000;
  const maxAgeMs = 80 * 365.25 * 24 * 3600 * 1000;
  const ageMs = minAgeMs + rng() * (maxAgeMs - minAgeMs);
  return new Date(now - ageMs);
}
