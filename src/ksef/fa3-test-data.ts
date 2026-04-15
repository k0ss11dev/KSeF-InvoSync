// SPDX-License-Identifier: GPL-3.0-or-later
// Test invoice factory — produces deterministic, valid StructuredInvoice
// objects for unit tests, manual testing, and the eventual seed-test-invoices
// CLI script. Output is randomized when no seed is given, deterministic when
// a seed is passed (for snapshot tests and reproducible bug reports).
//
// This file is the "now only for test data" half of the user's request.
// The other future input sources (photo OCR, PDF extraction, LLM natural
// language) would live in sibling files (fa3-from-photo.ts etc.) when we
// build them — they'd produce the same StructuredInvoice type and feed
// the same FA3Builder. See fa3-types.ts for the architecture diagram.

import type {
  InvoiceLine,
  InvoiceParty,
  PaymentInfo,
  StructuredInvoice,
  VatRate,
} from "./fa3-types";
import { generateNip } from "./polish-ids";

export type GenerateTestInvoiceOpts = {
  /**
   * Seed for the (very simple) deterministic RNG. If omitted, the factory
   * uses Math.random() and produces a different invoice each call.
   */
  seed?: number;
  /** Override the seller. Default: synthetic Polish company. */
  seller?: Partial<InvoiceParty>;
  /** Override the buyer. Default: different synthetic Polish company. */
  buyer?: Partial<InvoiceParty>;
  /** How many line items. Default: 1..5 depending on seed. */
  lineCount?: number;
  /** Force a specific VAT rate on all lines. Default: "23". */
  vatRate?: VatRate;
  /** Override the invoice number. Default: auto-generated. */
  invoiceNumber?: string;
  /** Override the issue date (YYYY-MM-DD). Default: today. */
  issueDate?: string;
  /** Override the currency. Default: "PLN". */
  currency?: string;
  /** Mark the invoice as paid + set form/date. Default: cash, paid today. */
  payment?: Partial<PaymentInfo>;
};

// Party templates — name + address only. NIPs are generated fresh on each
// call via `generateNip()` so they always pass Polish checksum validation.
// (Hardcoded NIPs are a footgun: only ~91% of random 10-digit strings have
// a valid checksum, and KSeF rejects the rest.)
type PartyTemplate = Omit<InvoiceParty, "nip">;

const DEFAULT_SELLER_TEMPLATE: PartyTemplate = {
  name: "Test Seller Sp. z o.o.",
  address: {
    countryCode: "PL",
    line1: "ul. Marszałkowska 12",
    line2: "00-001 Warszawa",
  },
  contact: {
    email: "kontakt@test-seller.example",
    phone: "+48 22 000 00 00",
  },
};

const BUYER_TEMPLATES: PartyTemplate[] = [
  {
    name: "Test Buyer A Sp. z o.o.",
    address: {
      countryCode: "PL",
      line1: "ul. Krakowskie Przedmieście 5",
      line2: "00-068 Warszawa",
    },
    contact: { email: "buyer-a@example.com" },
  },
  {
    name: "Test Buyer B S.A.",
    address: {
      countryCode: "PL",
      line1: "ul. Floriańska 22",
      line2: "31-021 Kraków",
    },
    contact: { email: "buyer-b@example.com", phone: "+48 12 111 11 11" },
  },
  {
    name: "Test Buyer C Spółdzielnia",
    address: {
      countryCode: "PL",
      line1: "ul. Długi Targ 8",
      line2: "80-828 Gdańsk",
    },
  },
];

const SAMPLE_LINE_ITEMS: Array<{ description: string; unit: string; price: number }> = [
  { description: "Konsultacja wdrożeniowa KSeF", unit: "godz.", price: 250.0 },
  { description: "Audyt zgodności faktur z FA(3)", unit: "szt.", price: 1500.0 },
  { description: "Szkolenie z e-fakturowania (1 dzień)", unit: "szt.", price: 2200.0 },
  { description: "Pakiet integracji API KSeF", unit: "szt.", price: 4800.0 },
  { description: "Wsparcie techniczne — abonament miesięczny", unit: "mies.", price: 800.0 },
  { description: "Migracja faktur archiwalnych", unit: "szt.", price: 1200.0 },
  { description: "Konfiguracja certyfikatu KSeF", unit: "szt.", price: 350.0 },
  { description: "Przygotowanie szablonu faktury korygującej", unit: "szt.", price: 600.0 },
];

/**
 * Generate a single test StructuredInvoice. With no opts, returns a randomized
 * Polish-style invoice. With a seed, returns a deterministic one — same seed
 * produces same output, useful for snapshot tests.
 */
export function generateTestInvoice(
  opts: GenerateTestInvoiceOpts = {},
): StructuredInvoice {
  const rng = makeRng(opts.seed);

  const today = opts.issueDate ?? new Date().toISOString().slice(0, 10);
  const invoiceNumber =
    opts.invoiceNumber ??
    `FA/TEST/${today.replace(/-/g, "")}/${String(Math.floor(rng() * 9999) + 1).padStart(4, "0")}`;

  // NIPs come from generateNip() so they always pass Polish checksum
  // validation. The same RNG drives both NIP generation and the buyer
  // template pick, so deterministic-with-seed callers get deterministic
  // (template, NIP) pairs.
  const buyerTemplate =
    BUYER_TEMPLATES[Math.floor(rng() * BUYER_TEMPLATES.length)];
  const buyer: InvoiceParty = {
    ...buyerTemplate,
    nip: generateNip(rng),
    ...opts.buyer,
  };
  const seller: InvoiceParty = {
    ...DEFAULT_SELLER_TEMPLATE,
    nip: generateNip(rng),
    ...opts.seller,
  };

  const lineCount = opts.lineCount ?? Math.floor(rng() * 5) + 1; // 1..5
  const vatRate = opts.vatRate ?? "23";
  const lines: InvoiceLine[] = [];
  for (let i = 0; i < lineCount; i++) {
    const sample = SAMPLE_LINE_ITEMS[Math.floor(rng() * SAMPLE_LINE_ITEMS.length)];
    const quantity = Math.floor(rng() * 9) + 1; // 1..9
    lines.push({
      description: sample.description,
      unit: sample.unit,
      quantity,
      unitPriceNet: sample.price,
      vatRate,
    });
  }

  const dueDateObj = new Date();
  dueDateObj.setDate(dueDateObj.getDate() + 14);
  const dueDate = dueDateObj.toISOString().slice(0, 10);

  const payment: PaymentInfo = {
    paid: false,
    dueDate,
    formCode: 6, // bank transfer
    ...opts.payment,
  };

  return {
    metadata: {
      invoiceNumber,
      issueDate: today,
      sellDate: today,
      issuePlace: "Warszawa",
      currency: opts.currency ?? "PLN",
      invoiceType: "VAT",
      systemInfo: "invo-sync test data",
    },
    seller,
    buyer,
    lines,
    payment,
  };
}

/**
 * Generate `count` distinct test invoices. With a seed, the sequence is
 * deterministic — calling generateTestInvoiceBatch(5, { seed: 42 }) twice
 * produces the same 5 invoices both times.
 */
export function generateTestInvoiceBatch(
  count: number,
  opts: GenerateTestInvoiceOpts = {},
): StructuredInvoice[] {
  const baseSeed = opts.seed ?? Math.floor(Math.random() * 1_000_000);
  const result: StructuredInvoice[] = [];
  for (let i = 0; i < count; i++) {
    result.push(
      generateTestInvoice({
        ...opts,
        seed: baseSeed + i,
        // Each invoice in the batch needs a unique invoice number — derive
        // from the seed offset so the deterministic case is preserved.
        invoiceNumber: opts.invoiceNumber
          ? `${opts.invoiceNumber}-${i + 1}`
          : undefined,
      }),
    );
  }
  return result;
}

// --- Tiny deterministic RNG ----------------------------------------------

/**
 * Mulberry32 — a simple 32-bit deterministic PRNG. Not cryptographic, not
 * statistically excellent, but stable across Node versions and good enough
 * for picking sample line items in test fixtures. Returns a function that
 * yields a fresh float in [0, 1) on each call.
 */
function makeRng(seed?: number): () => number {
  if (seed === undefined) return Math.random;
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
