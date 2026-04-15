// SPDX-License-Identifier: GPL-3.0-or-later
// Unit tests for the FA(3) XML builder + the test invoice factory.
//
// What we test:
//   - Builder output has the right XML namespace, root element, and required
//     top-level blocks (Naglowek, Podmiot1, Podmiot2, Fa)
//   - Polish field codes (P_1, P_2, P_7, P_13_1, etc.) appear in the right places
//   - Validation catches missing required fields, malformed dates, bad NIPs,
//     unknown VAT rates
//   - Totals math is correct: net per rate, VAT per rate, gross
//   - Multiple VAT rates produce P_13_1 + P_13_2 etc. in rate order
//   - XML special characters (& < > " ') are escaped in user-supplied strings
//   - Test data factory: deterministic with seed, randomized without
//   - Builder output round-trips through validate() inside build() with no errors
//
// What we DO NOT test (out of scope for this turn):
//   - Validation against the real FA(3) XSD (no XSD validator in deps)
//   - Wire upload to KSeF (that's a later sub-turn — open session, encrypt, POST)
//   - Business-rule validation that KSeF's server-side validator does
//     (split-payment thresholds, GTU codes, etc.)

import { expect, test } from "@playwright/test";
import { FA3Builder } from "../../src/ksef/fa3-builder";
import {
  generateTestInvoice,
  generateTestInvoiceBatch,
} from "../../src/ksef/fa3-test-data";
import type { StructuredInvoice } from "../../src/ksef/fa3-types";

const FA3_NS = "http://crd.gov.pl/wzor/2025/06/25/13775/";

function makeMinimalInvoice(): StructuredInvoice {
  return {
    metadata: {
      invoiceNumber: "FA/TEST/0001",
      issueDate: "2026-04-12",
      currency: "PLN",
      invoiceType: "VAT",
    },
    seller: {
      nip: "8698281999",
      name: "Acme Test Sp. z o.o.",
      address: { countryCode: "PL", line1: "ul. Test 1", line2: "00-001 Warszawa" },
    },
    buyer: {
      nip: "5252344078",
      name: "Buyer Test S.A.",
      address: { countryCode: "PL", line1: "ul. Test 2", line2: "00-002 Warszawa" },
    },
    lines: [
      {
        description: "Test consulting hour",
        unit: "godz.",
        quantity: 4,
        unitPriceNet: 250,
        vatRate: "23",
      },
    ],
  };
}

// --- Builder structure ----------------------------------------------------

test.describe("FA3Builder — XML structure", () => {
  test("emits the correct namespace and root element", () => {
    const xml = new FA3Builder().build(makeMinimalInvoice());
    expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(xml).toContain(`<Faktura xmlns="${FA3_NS}">`);
    expect(xml).toContain("</Faktura>");
  });

  test("includes the four required top-level blocks in order", () => {
    const xml = new FA3Builder().build(makeMinimalInvoice());
    const naglowek = xml.indexOf("<Naglowek>");
    const podmiot1 = xml.indexOf("<Podmiot1>");
    const podmiot2 = xml.indexOf("<Podmiot2>");
    const fa = xml.indexOf("<Fa>");
    expect(naglowek).toBeGreaterThan(0);
    expect(podmiot1).toBeGreaterThan(naglowek);
    expect(podmiot2).toBeGreaterThan(podmiot1);
    expect(fa).toBeGreaterThan(podmiot2);
  });

  test("Naglowek has the FA(3) form code, schema version, and variant", () => {
    const xml = new FA3Builder().build(makeMinimalInvoice());
    expect(xml).toContain('kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza>');
    expect(xml).toContain("<WariantFormularza>3</WariantFormularza>");
    expect(xml).toContain("<DataWytworzeniaFa>");
  });

  test("Podmiot1 / Podmiot2 contain seller / buyer NIP and name", () => {
    const xml = new FA3Builder().build(makeMinimalInvoice());
    expect(xml).toContain("<NIP>8698281999</NIP>");
    expect(xml).toContain("<Nazwa>Acme Test Sp. z o.o.</Nazwa>");
    expect(xml).toContain("<NIP>5252344078</NIP>");
    expect(xml).toContain("<Nazwa>Buyer Test S.A.</Nazwa>");
  });

  test("Fa block contains issue date, invoice number, currency, totals", () => {
    const xml = new FA3Builder().build(makeMinimalInvoice());
    expect(xml).toContain("<KodWaluty>PLN</KodWaluty>");
    expect(xml).toContain("<P_1>2026-04-12</P_1>");
    expect(xml).toContain("<P_2>FA/TEST/0001</P_2>");
    expect(xml).toContain("<P_6>2026-04-12</P_6>"); // sellDate defaults to issueDate
    // 4 hours × 250 = 1000 net, 23% VAT = 230, gross 1230
    expect(xml).toContain("<P_13_1>1000.00</P_13_1>");
    expect(xml).toContain("<P_14_1>230.00</P_14_1>");
    expect(xml).toContain("<P_15>1230.00</P_15>");
  });

  test("Adnotacje block is present with all required compliance flags", () => {
    const xml = new FA3Builder().build(makeMinimalInvoice());
    expect(xml).toContain("<Adnotacje>");
    expect(xml).toContain("<P_16>2</P_16>");
    expect(xml).toContain("<P_17>2</P_17>");
    expect(xml).toContain("<P_18>2</P_18>");
    expect(xml).toContain("<P_18A>2</P_18A>");
    expect(xml).toContain("<Zwolnienie>");
    expect(xml).toContain("<P_19N>1</P_19N>");
    expect(xml).toContain("<NoweSrodkiTransportu>");
    expect(xml).toContain("<P_22N>1</P_22N>");
    expect(xml).toContain("<PMarzy>");
    expect(xml).toContain("<P_PMarzyN>1</P_PMarzyN>");
  });

  test("RodzajFaktury is VAT", () => {
    const xml = new FA3Builder().build(makeMinimalInvoice());
    expect(xml).toContain("<RodzajFaktury>VAT</RodzajFaktury>");
  });

  test("FaWiersz line items have all required fields in order", () => {
    const xml = new FA3Builder().build(makeMinimalInvoice());
    expect(xml).toContain("<FaWiersz>");
    expect(xml).toContain("<NrWierszaFa>1</NrWierszaFa>");
    expect(xml).toContain("<P_7>Test consulting hour</P_7>");
    expect(xml).toContain("<P_8A>godz.</P_8A>");
    expect(xml).toContain("<P_8B>4</P_8B>");
    expect(xml).toContain("<P_9A>250.00</P_9A>");
    expect(xml).toContain("<P_11>1000.00</P_11>");
    expect(xml).toContain("<P_12>23</P_12>");
  });
});

// --- Math: totals ---------------------------------------------------------

test.describe("FA3Builder — totals math", () => {
  test("computes single-rate net + VAT + gross correctly", () => {
    const totals = new FA3Builder().computeTotals([
      { description: "x", unit: "szt.", quantity: 2, unitPriceNet: 100, vatRate: "23" },
      { description: "y", unit: "szt.", quantity: 1, unitPriceNet: 50, vatRate: "23" },
    ]);
    expect(totals.totalNet).toBe(250); // 200 + 50
    expect(totals.totalVat).toBe(57.5); // 250 * 0.23
    expect(totals.totalGross).toBe(307.5);
  });

  test("groups totals by VAT rate and emits one P_13_X per rate", () => {
    const invoice = makeMinimalInvoice();
    invoice.lines = [
      { description: "23%", unit: "szt.", quantity: 1, unitPriceNet: 100, vatRate: "23" },
      { description: "8%", unit: "szt.", quantity: 1, unitPriceNet: 100, vatRate: "8" },
      { description: "5%", unit: "szt.", quantity: 1, unitPriceNet: 100, vatRate: "5" },
    ];
    const xml = new FA3Builder().build(invoice);
    expect(xml).toContain("<P_13_1>100.00</P_13_1>"); // 23%
    expect(xml).toContain("<P_14_1>23.00</P_14_1>");
    expect(xml).toContain("<P_13_2>100.00</P_13_2>"); // 8%
    expect(xml).toContain("<P_14_2>8.00</P_14_2>");
    expect(xml).toContain("<P_13_3>100.00</P_13_3>"); // 5%
    expect(xml).toContain("<P_14_3>5.00</P_14_3>");
    expect(xml).toContain("<P_15>336.00</P_15>"); // total gross
  });

  test("rounds half-away-from-zero on cent boundaries", () => {
    // 0.235 * 0.23 = 0.05405 → should round to 0.05 not 0.06 with half-up
    // 100 * 0.235 = 23.50 net, VAT = 23.50 * 0.23 = 5.405 → rounds to 5.41
    const totals = new FA3Builder().computeTotals([
      { description: "x", unit: "szt.", quantity: 100, unitPriceNet: 0.235, vatRate: "23" },
    ]);
    expect(totals.totalNet).toBe(23.5);
    expect(totals.totalVat).toBe(5.41);
    expect(totals.totalGross).toBe(28.91);
  });
});

// --- Validation -----------------------------------------------------------

test.describe("FA3Builder — validation", () => {
  const builder = new FA3Builder();

  test("rejects missing invoice number", () => {
    const invoice = makeMinimalInvoice();
    invoice.metadata.invoiceNumber = "";
    expect(() => builder.build(invoice)).toThrow(/invoiceNumber is required/);
  });

  test("rejects malformed issue date", () => {
    const invoice = makeMinimalInvoice();
    invoice.metadata.issueDate = "12/04/2026";
    expect(() => builder.build(invoice)).toThrow(/issueDate must be YYYY-MM-DD/);
  });

  test("rejects NIP that isn't 10 digits", () => {
    const invoice = makeMinimalInvoice();
    invoice.seller.nip = "123";
    expect(() => builder.build(invoice)).toThrow(/seller\.nip must be 10 digits/);
  });

  test("rejects empty line array", () => {
    const invoice = makeMinimalInvoice();
    invoice.lines = [];
    expect(() => builder.build(invoice)).toThrow(/at least one line/);
  });

  test("rejects negative quantity", () => {
    const invoice = makeMinimalInvoice();
    invoice.lines[0].quantity = -1;
    expect(() => builder.build(invoice)).toThrow(/quantity must be > 0/);
  });

  test("rejects unknown VAT rate", () => {
    const invoice = makeMinimalInvoice();
    // @ts-expect-error — testing runtime guard against bad input
    invoice.lines[0].vatRate = "99";
    expect(() => builder.build(invoice)).toThrow(/not a valid Polish VAT code/);
  });

  test("rejects payment.paid=true without paidDate", () => {
    const invoice = makeMinimalInvoice();
    invoice.payment = { paid: true };
    expect(() => builder.build(invoice)).toThrow(/paidDate is required when payment\.paid=true/);
  });
});

// --- XML escaping ---------------------------------------------------------

test.describe("FA3Builder — XML escaping", () => {
  test("escapes & < > in seller name", () => {
    const invoice = makeMinimalInvoice();
    invoice.seller.name = 'Smith & Sons <Co.>';
    const xml = new FA3Builder().build(invoice);
    expect(xml).toContain("Smith &amp; Sons &lt;Co.&gt;");
    expect(xml).not.toContain("Smith & Sons <Co.>");
  });

  test("escapes special chars in line description", () => {
    const invoice = makeMinimalInvoice();
    invoice.lines[0].description = `Service "premium" & extras`;
    const xml = new FA3Builder().build(invoice);
    expect(xml).toContain("Service &quot;premium&quot; &amp; extras");
  });
});

// --- Test data factory ----------------------------------------------------

test.describe("generateTestInvoice", () => {
  test("produces a valid invoice that builds without errors", () => {
    const invoice = generateTestInvoice({ seed: 42 });
    expect(() => new FA3Builder().build(invoice)).not.toThrow();
  });

  test("with the same seed produces the same invoice", () => {
    const a = generateTestInvoice({ seed: 12345 });
    const b = generateTestInvoice({ seed: 12345 });
    expect(a.metadata.invoiceNumber).toBe(b.metadata.invoiceNumber);
    expect(a.lines.length).toBe(b.lines.length);
    expect(a.lines[0].description).toBe(b.lines[0].description);
    expect(a.lines[0].quantity).toBe(b.lines[0].quantity);
  });

  test("with different seeds produces different invoices", () => {
    const a = generateTestInvoice({ seed: 1 });
    const b = generateTestInvoice({ seed: 999999 });
    // The factory has many degrees of freedom; at least the invoice number should differ.
    expect(a.metadata.invoiceNumber).not.toBe(b.metadata.invoiceNumber);
  });

  test("respects vatRate override", () => {
    const invoice = generateTestInvoice({ seed: 1, vatRate: "8" });
    invoice.lines.forEach((l) => expect(l.vatRate).toBe("8"));
  });

  test("respects lineCount override", () => {
    const invoice = generateTestInvoice({ seed: 1, lineCount: 7 });
    expect(invoice.lines.length).toBe(7);
  });

  test("uses today's date by default", () => {
    const invoice = generateTestInvoice();
    const today = new Date().toISOString().slice(0, 10);
    expect(invoice.metadata.issueDate).toBe(today);
  });
});

test.describe("generateTestInvoiceBatch", () => {
  test("produces N distinct invoices", () => {
    const invoices = generateTestInvoiceBatch(5, { seed: 1 });
    expect(invoices.length).toBe(5);
    const numbers = new Set(invoices.map((inv) => inv.metadata.invoiceNumber));
    expect(numbers.size).toBe(5);
  });

  test("is deterministic with a seed", () => {
    const a = generateTestInvoiceBatch(3, { seed: 42 });
    const b = generateTestInvoiceBatch(3, { seed: 42 });
    expect(a.map((i) => i.metadata.invoiceNumber)).toEqual(
      b.map((i) => i.metadata.invoiceNumber),
    );
  });

  test("every batch item builds to valid XML", () => {
    const builder = new FA3Builder();
    const invoices = generateTestInvoiceBatch(10, { seed: 123 });
    for (const invoice of invoices) {
      expect(() => builder.build(invoice)).not.toThrow();
    }
  });
});
