// SPDX-License-Identifier: GPL-3.0-or-later
// Unit tests for the InvoiceMetadata → spreadsheet row mapping. Pure logic,
// no browser, no network.

import { expect, test } from "@playwright/test";
import {
  DEFAULT_KSEF_HEADERS,
  mapInvoiceToRow,
  mapInvoicesToRows,
  sanitizeCellValue,
} from "../../src/google/sheets";
import type { InvoiceMetadata } from "../../src/ksef/types";

const FULL_INVOICE: InvoiceMetadata = {
  ksefNumber: "5555555555-20260411-MOCK00000000-E0",
  invoiceNumber: "FA/MOCK/0001",
  issueDate: "2026-04-11",
  invoicingDate: "2026-04-11T10:00:00Z",
  acquisitionDate: "2026-04-11T10:01:00Z",
  permanentStorageDate: "2026-04-11T10:02:00Z",
  seller: { nip: "5555555555", name: "Mock Seller Sp. z o.o." },
  buyer: {
    identifier: { type: "Nip", value: "1234567890" },
    name: "Mock Buyer 1",
  },
  netAmount: 1000.0,
  vatAmount: 230.0,
  grossAmount: 1230.0,
  currency: "PLN",
  invoicingMode: "Online",
  invoiceType: "Vat",
};

test.describe("DEFAULT_KSEF_HEADERS", () => {
  test("has 14 columns", () => {
    expect(DEFAULT_KSEF_HEADERS.length).toBe(14);
  });

  test("includes the load-bearing columns in the right order", () => {
    expect(DEFAULT_KSEF_HEADERS[0]).toBe("KSeF Number");
    expect(DEFAULT_KSEF_HEADERS[1]).toBe("Invoice Number");
    expect(DEFAULT_KSEF_HEADERS[4]).toBe("Seller NIP");
    expect(DEFAULT_KSEF_HEADERS[6]).toBe("Buyer NIP");
    expect(DEFAULT_KSEF_HEADERS[8]).toBe("Net Amount");
    expect(DEFAULT_KSEF_HEADERS[10]).toBe("Gross Amount");
    expect(DEFAULT_KSEF_HEADERS[13]).toBe("Invoice Type");
  });
});

test.describe("mapInvoiceToRow", () => {
  test("emits one cell per header column", () => {
    const row = mapInvoiceToRow(FULL_INVOICE);
    expect(row.length).toBe(DEFAULT_KSEF_HEADERS.length);
  });

  test("places fields in the documented order", () => {
    const row = mapInvoiceToRow(FULL_INVOICE);
    expect(row[0]).toBe("5555555555-20260411-MOCK00000000-E0"); // KSeF Number
    expect(row[1]).toBe("FA/MOCK/0001"); // Invoice Number
    expect(row[2]).toBe("2026-04-11"); // Issue Date
    expect(row[3]).toBe("2026-04-11T10:02:00Z"); // Permanent Storage Date
    expect(row[4]).toBe("5555555555"); // Seller NIP
    expect(row[5]).toBe("Mock Seller Sp. z o.o."); // Seller Name
    expect(row[6]).toBe("1234567890"); // Buyer NIP
    expect(row[7]).toBe("Mock Buyer 1"); // Buyer Name
    expect(row[8]).toBe(1000.0); // Net Amount
    expect(row[9]).toBe(230.0); // VAT Amount
    expect(row[10]).toBe(1230.0); // Gross Amount
    expect(row[11]).toBe("PLN"); // Currency
    expect(row[12]).toBe("Online"); // Invoicing Mode
    expect(row[13]).toBe("Vat"); // Invoice Type
  });

  test("emits numbers as numbers, not strings (so Sheets sums work)", () => {
    const row = mapInvoiceToRow(FULL_INVOICE);
    expect(typeof row[8]).toBe("number");
    expect(typeof row[9]).toBe("number");
    expect(typeof row[10]).toBe("number");
  });

  test("falls back to empty strings or null when fields are missing", () => {
    const sparse: InvoiceMetadata = {
      ksefNumber: "5555555555-20260411-X-00",
      invoiceNumber: "FA/X/1",
      issueDate: "2026-04-11",
      invoicingDate: "2026-04-11T10:00:00Z",
      permanentStorageDate: "2026-04-11T10:02:00Z",
      seller: {},
      buyer: {},
    };
    const row = mapInvoiceToRow(sparse);

    expect(row[4]).toBe(""); // Seller NIP — missing
    expect(row[5]).toBe(""); // Seller Name — missing
    expect(row[6]).toBe(""); // Buyer NIP — missing
    expect(row[7]).toBe(""); // Buyer Name — missing
    expect(row[8]).toBeNull(); // Net Amount — missing
    expect(row[9]).toBeNull(); // VAT Amount — missing
    expect(row[10]).toBeNull(); // Gross Amount — missing
    expect(row[11]).toBe(""); // Currency — missing
  });

  test("uses seller.nip in preference to seller.identifier.value", () => {
    const invoice: InvoiceMetadata = {
      ...FULL_INVOICE,
      seller: { nip: "1111111111", identifier: { type: "Nip", value: "2222222222" } },
    };
    expect(mapInvoiceToRow(invoice)[4]).toBe("1111111111");
  });

  test("falls back to seller.identifier.value when seller.nip is missing", () => {
    const invoice: InvoiceMetadata = {
      ...FULL_INVOICE,
      seller: { identifier: { type: "Nip", value: "3333333333" } },
    };
    expect(mapInvoiceToRow(invoice)[4]).toBe("3333333333");
  });
});

test.describe("mapInvoicesToRows", () => {
  test("maps an array of invoices preserving order", () => {
    const invoices: InvoiceMetadata[] = [
      FULL_INVOICE,
      { ...FULL_INVOICE, ksefNumber: "second", invoiceNumber: "FA/MOCK/0002" },
    ];
    const rows = mapInvoicesToRows(invoices);
    expect(rows.length).toBe(2);
    expect(rows[0][0]).toBe(FULL_INVOICE.ksefNumber);
    expect(rows[1][0]).toBe("second");
    expect(rows[1][1]).toBe("FA/MOCK/0002");
  });

  test("returns an empty array for an empty input", () => {
    expect(mapInvoicesToRows([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Finding #4: Formula injection via KSeF-supplied seller/buyer names etc.
// Sheets treats leading = + - @ \t \r as formula starts under USER_ENTERED
// input mode. sanitizeCellValue prefixes a single quote to neutralise.
// ---------------------------------------------------------------------------

test.describe("sanitizeCellValue (formula injection guard)", () => {
  test("prefixes = with single quote", () => {
    expect(sanitizeCellValue("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
  });

  test("prefixes + with single quote", () => {
    expect(sanitizeCellValue("+1234567890")).toBe("'+1234567890");
  });

  test("prefixes - with single quote", () => {
    expect(sanitizeCellValue("-discount")).toBe("'-discount");
  });

  test("prefixes @ with single quote", () => {
    expect(sanitizeCellValue("@user")).toBe("'@user");
  });

  test("prefixes leading tab", () => {
    expect(sanitizeCellValue("\t=evil")).toBe("'\t=evil");
  });

  test("prefixes leading CR", () => {
    expect(sanitizeCellValue("\r=evil")).toBe("'\r=evil");
  });

  test("passes normal text through unchanged", () => {
    expect(sanitizeCellValue("ACME Corp")).toBe("ACME Corp");
    expect(sanitizeCellValue("Sp. z o.o.")).toBe("Sp. z o.o.");
    expect(sanitizeCellValue("5555555555")).toBe("5555555555");
  });

  test("passes numeric values through unchanged (not stringified)", () => {
    expect(sanitizeCellValue(100.5)).toBe(100.5);
    expect(sanitizeCellValue(0)).toBe(0);
    expect(sanitizeCellValue(null)).toBe(null);
  });
});

test.describe("mapInvoiceToRow — formula injection through real invoice fields", () => {
  test("neutralises malicious seller name", () => {
    const inv: InvoiceMetadata = {
      ...FULL_INVOICE,
      seller: { nip: "5555555555", name: "=HYPERLINK(\"https://evil\",\"Faktura\")" },
    };
    const row = mapInvoiceToRow(inv);
    // Column 5 (index 5) is seller name
    expect(row[5]).toBe("'=HYPERLINK(\"https://evil\",\"Faktura\")");
  });

  test("neutralises malicious buyer name", () => {
    const inv: InvoiceMetadata = {
      ...FULL_INVOICE,
      buyer: { nip: "1234567890", name: "@attacker" },
    };
    const row = mapInvoiceToRow(inv);
    expect(row[7]).toBe("'@attacker");
  });

  test("neutralises malicious invoice number", () => {
    const inv: InvoiceMetadata = { ...FULL_INVOICE, invoiceNumber: "-EVIL" };
    const row = mapInvoiceToRow(inv);
    expect(row[1]).toBe("'-EVIL");
  });

  test("leaves numeric amounts unchanged (not wrapped)", () => {
    const row = mapInvoiceToRow(FULL_INVOICE);
    expect(row[8]).toBe(1000); // netAmount
    expect(typeof row[8]).toBe("number");
  });
});
