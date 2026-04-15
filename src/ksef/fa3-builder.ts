// SPDX-License-Identifier: GPL-3.0-or-later
// FA3Builder — converts a StructuredInvoice (source-agnostic domain model)
// into a valid FA(3) XML string suitable for upload to KSeF.
//
// Reference: a known-valid FA(3) sample from the official CIRFMF/ksef-pdf-generator
// repository at assets/invoice.xml. We follow its element ordering, namespace,
// and `<Adnotacje>` defaults. Schema version: FA(3) 1-0E, released for the
// 2026-02-01 phase 1 cutover.
//
// What this file does NOT do:
//   - Validate against the actual FA(3) XSD (we'd need the XSD + a DOM
//     validator; out of scope for v1). Instead we hand-construct the XML
//     to match the structure of the known-valid sample, and rely on the
//     KSeF server's validator to reject anything malformed.
//   - Encrypt the XML for upload — that's the M3 sub-turn 4-LATER work
//     (open /v2/sessions/online with an AES-encrypted symmetric key,
//     encrypt each invoice's XML with that key, POST to .../invoices).
//   - Compute SHA-256 hashes of the plaintext + ciphertext (also upload-time).
//
// What this file DOES do:
//   - Take a StructuredInvoice
//   - Validate that the required fields are present
//   - Compute totals (P_13_X net by VAT rate, P_14_X VAT by rate, P_15 gross)
//   - Emit a valid FA(3) XML string with the right namespace and element ordering
//   - Escape XML special characters in user-supplied strings

import type {
  InvoiceLine,
  InvoiceParty,
  PaymentInfo,
  StructuredInvoice,
  VatRate,
} from "./fa3-types";

const FA3_NAMESPACE = "http://crd.gov.pl/wzor/2025/06/25/13775/";
const FA3_FORM_CODE = "FA";
const FA3_FORM_VARIANT = "3";
const FA3_SCHEMA_SYSTEM_CODE = "FA (3)";
const FA3_SCHEMA_VERSION = "1-0E";
const DEFAULT_SYSTEM_INFO = "invo-sync";

/**
 * Map from VAT rate code to FA(3) total-element index suffix.
 *   _1 → 23%   _2 → 8%   _3 → 5%   _4 → 0%   _5 → exempt   _6 → reverse charge   _7 → not taxable
 *
 * The FA(3) schema groups invoice totals by VAT rate using these indexed
 * elements (P_13_1, P_14_1 for the 23% net+VAT subtotals, P_13_2/P_14_2
 * for the 8%, etc.). We only emit elements for rates that have at least
 * one line item.
 */
const VAT_RATE_INDEX: Record<VatRate, number> = {
  "23": 1,
  "8": 2,
  "5": 3,
  "0": 4,
  zw: 5,
  oo: 6,
  np: 7,
};

const VAT_RATE_NUMERIC: Record<VatRate, number> = {
  "23": 0.23,
  "8": 0.08,
  "5": 0.05,
  "0": 0,
  zw: 0,
  oo: 0,
  np: 0,
};

export type ComputedTotals = {
  /** Net amount per VAT rate (only rates with non-zero lines are present). */
  netByRate: Map<VatRate, number>;
  /** VAT amount per VAT rate (computed from net × rate). */
  vatByRate: Map<VatRate, number>;
  /** Sum of all net amounts. */
  totalNet: number;
  /** Sum of all VAT amounts. */
  totalVat: number;
  /** Total gross = totalNet + totalVat. */
  totalGross: number;
};

export class FA3Builder {
  /**
   * Convert a StructuredInvoice into a valid FA(3) XML string.
   * Throws if any required field is missing or malformed.
   */
  build(invoice: StructuredInvoice): string {
    this.validate(invoice);
    const totals = this.computeTotals(invoice.lines);

    const parts: string[] = [];
    parts.push('<?xml version="1.0" encoding="utf-8"?>');
    parts.push(`<Faktura xmlns="${FA3_NAMESPACE}">`);
    parts.push(this.buildNaglowek(invoice));
    parts.push(this.buildPodmiot("Podmiot1", invoice.seller));
    parts.push(this.buildPodmiot("Podmiot2", invoice.buyer));
    parts.push(this.buildFa(invoice, totals));
    parts.push("</Faktura>");
    return parts.join("\n");
  }

  /**
   * Compute totals grouped by VAT rate. Exposed publicly so tests can assert
   * the math without re-parsing the generated XML.
   */
  computeTotals(lines: readonly InvoiceLine[]): ComputedTotals {
    const netByRate = new Map<VatRate, number>();
    const vatByRate = new Map<VatRate, number>();

    for (const line of lines) {
      const lineNet = round2(line.quantity * line.unitPriceNet);
      const prevNet = netByRate.get(line.vatRate) ?? 0;
      netByRate.set(line.vatRate, round2(prevNet + lineNet));
    }

    let totalNet = 0;
    let totalVat = 0;
    for (const [rate, net] of netByRate.entries()) {
      const vat = round2(net * VAT_RATE_NUMERIC[rate]);
      vatByRate.set(rate, vat);
      totalNet = round2(totalNet + net);
      totalVat = round2(totalVat + vat);
    }

    return {
      netByRate,
      vatByRate,
      totalNet,
      totalVat,
      totalGross: round2(totalNet + totalVat),
    };
  }

  // --- Internals ----------------------------------------------------------

  private validate(invoice: StructuredInvoice): void {
    const m = invoice.metadata;
    if (!m?.invoiceNumber) throw new Error("FA3Builder: metadata.invoiceNumber is required");
    if (!m?.issueDate) throw new Error("FA3Builder: metadata.issueDate is required");
    if (!isDateString(m.issueDate)) {
      throw new Error(`FA3Builder: metadata.issueDate must be YYYY-MM-DD, got "${m.issueDate}"`);
    }
    if (m.sellDate && !isDateString(m.sellDate)) {
      throw new Error(`FA3Builder: metadata.sellDate must be YYYY-MM-DD, got "${m.sellDate}"`);
    }
    if (!m?.currency) throw new Error("FA3Builder: metadata.currency is required");
    if (m.invoiceType !== "VAT") {
      throw new Error(`FA3Builder: only invoiceType="VAT" is supported in v1 (got "${m.invoiceType}")`);
    }
    this.validateParty(invoice.seller, "seller");
    this.validateParty(invoice.buyer, "buyer");
    if (!Array.isArray(invoice.lines) || invoice.lines.length === 0) {
      throw new Error("FA3Builder: invoice must have at least one line");
    }
    invoice.lines.forEach((line, i) => {
      if (!line.description) throw new Error(`FA3Builder: lines[${i}].description is required`);
      if (!line.unit) throw new Error(`FA3Builder: lines[${i}].unit is required`);
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
        throw new Error(`FA3Builder: lines[${i}].quantity must be > 0`);
      }
      if (!Number.isFinite(line.unitPriceNet) || line.unitPriceNet < 0) {
        throw new Error(`FA3Builder: lines[${i}].unitPriceNet must be >= 0`);
      }
      if (!(line.vatRate in VAT_RATE_INDEX)) {
        throw new Error(`FA3Builder: lines[${i}].vatRate "${line.vatRate}" is not a valid Polish VAT code`);
      }
    });
    if (invoice.payment) {
      if (invoice.payment.paid && !invoice.payment.paidDate) {
        throw new Error("FA3Builder: payment.paidDate is required when payment.paid=true");
      }
      if (invoice.payment.paidDate && !isDateString(invoice.payment.paidDate)) {
        throw new Error(
          `FA3Builder: payment.paidDate must be YYYY-MM-DD, got "${invoice.payment.paidDate}"`,
        );
      }
    }
  }

  private validateParty(party: InvoiceParty, label: string): void {
    if (!party) throw new Error(`FA3Builder: ${label} is required`);
    if (!/^\d{10}$/.test(party.nip)) {
      throw new Error(`FA3Builder: ${label}.nip must be 10 digits, got "${party.nip}"`);
    }
    if (!party.name) throw new Error(`FA3Builder: ${label}.name is required`);
    if (!party.address?.countryCode) {
      throw new Error(`FA3Builder: ${label}.address.countryCode is required`);
    }
    if (!party.address?.line1 || !party.address?.line2) {
      throw new Error(`FA3Builder: ${label}.address.line1 and line2 are required`);
    }
  }

  private buildNaglowek(invoice: StructuredInvoice): string {
    const generated = new Date().toISOString();
    const sysInfo = invoice.metadata.systemInfo ?? DEFAULT_SYSTEM_INFO;
    return [
      "  <Naglowek>",
      `    <KodFormularza kodSystemowy="${FA3_SCHEMA_SYSTEM_CODE}" wersjaSchemy="${FA3_SCHEMA_VERSION}">${FA3_FORM_CODE}</KodFormularza>`,
      `    <WariantFormularza>${FA3_FORM_VARIANT}</WariantFormularza>`,
      `    <DataWytworzeniaFa>${generated}</DataWytworzeniaFa>`,
      `    <SystemInfo>${escapeXml(sysInfo)}</SystemInfo>`,
      "  </Naglowek>",
    ].join("\n");
  }

  private buildPodmiot(tag: "Podmiot1" | "Podmiot2", party: InvoiceParty): string {
    const lines: string[] = [];
    lines.push(`  <${tag}>`);
    lines.push("    <DaneIdentyfikacyjne>");
    lines.push(`      <NIP>${party.nip}</NIP>`);
    lines.push(`      <Nazwa>${escapeXml(party.name)}</Nazwa>`);
    lines.push("    </DaneIdentyfikacyjne>");
    lines.push("    <Adres>");
    lines.push(`      <KodKraju>${party.address.countryCode}</KodKraju>`);
    lines.push(`      <AdresL1>${escapeXml(party.address.line1)}</AdresL1>`);
    lines.push(`      <AdresL2>${escapeXml(party.address.line2)}</AdresL2>`);
    lines.push("    </Adres>");
    if (party.contact?.email || party.contact?.phone) {
      lines.push("    <DaneKontaktowe>");
      if (party.contact.email) {
        lines.push(`      <Email>${escapeXml(party.contact.email)}</Email>`);
      }
      if (party.contact.phone) {
        lines.push(`      <Telefon>${escapeXml(party.contact.phone)}</Telefon>`);
      }
      lines.push("    </DaneKontaktowe>");
    }
    if (tag === "Podmiot2") {
      // Buyer-only required (or strongly encouraged) compliance flags per
      // the CIRFMF sample. Both default to "2" = "not applicable":
      //   JST = Jednostka Samorządu Terytorialnego (is the buyer a local
      //         government unit? — relevant for VAT-exemption rules)
      //   GV  = Grupa VAT (is the buyer part of a VAT group?)
      // Omitting these caused KSeF's server-side FA(3) validator to crash
      // with a generic 500 "wystąpił nieoczekiwany błąd" — added 2026-04-11.
      lines.push("    <JST>2</JST>");
      lines.push("    <GV>2</GV>");
    }
    lines.push(`  </${tag}>`);
    return lines.join("\n");
  }

  private buildFa(invoice: StructuredInvoice, totals: ComputedTotals): string {
    const m = invoice.metadata;
    const sellDate = m.sellDate ?? m.issueDate;

    const lines: string[] = [];
    lines.push("  <Fa>");
    lines.push(`    <KodWaluty>${m.currency}</KodWaluty>`);
    lines.push(`    <P_1>${m.issueDate}</P_1>`);
    if (m.issuePlace) {
      lines.push(`    <P_1M>${escapeXml(m.issuePlace)}</P_1M>`);
    }
    lines.push(`    <P_2>${escapeXml(m.invoiceNumber)}</P_2>`);
    lines.push(`    <P_6>${sellDate}</P_6>`);

    // Totals: only emit P_13_X / P_14_X for rates that actually have lines.
    const sortedRates = Array.from(totals.netByRate.keys()).sort(
      (a, b) => VAT_RATE_INDEX[a] - VAT_RATE_INDEX[b],
    );
    for (const rate of sortedRates) {
      const idx = VAT_RATE_INDEX[rate];
      const net = totals.netByRate.get(rate) ?? 0;
      const vat = totals.vatByRate.get(rate) ?? 0;
      lines.push(`    <P_13_${idx}>${formatAmount(net)}</P_13_${idx}>`);
      // VAT amount is only meaningful for non-zero rates.
      if (vat > 0 || rate === "0") {
        lines.push(`    <P_14_${idx}>${formatAmount(vat)}</P_14_${idx}>`);
      }
    }
    lines.push(`    <P_15>${formatAmount(totals.totalGross)}</P_15>`);

    // Adnotacje: hard-coded "doesn't apply" defaults matching the CIRFMF
    // sample. The schema requires this block even when nothing applies.
    // Future work: derive these from the StructuredInvoice when we add
    // exemption / margin / split-payment / new-transport-means scenarios.
    lines.push("    <Adnotacje>");
    lines.push("      <P_16>2</P_16>");
    lines.push("      <P_17>2</P_17>");
    lines.push("      <P_18>2</P_18>");
    lines.push("      <P_18A>2</P_18A>");
    lines.push("      <Zwolnienie>");
    lines.push("        <P_19N>1</P_19N>");
    lines.push("      </Zwolnienie>");
    lines.push("      <NoweSrodkiTransportu>");
    lines.push("        <P_22N>1</P_22N>");
    lines.push("      </NoweSrodkiTransportu>");
    lines.push("      <P_23>2</P_23>");
    lines.push("      <PMarzy>");
    lines.push("        <P_PMarzyN>1</P_PMarzyN>");
    lines.push("      </PMarzy>");
    lines.push("    </Adnotacje>");

    lines.push(`    <RodzajFaktury>${m.invoiceType}</RodzajFaktury>`);

    // Line items
    invoice.lines.forEach((line, idx) => {
      const lineNet = round2(line.quantity * line.unitPriceNet);
      lines.push("    <FaWiersz>");
      lines.push(`      <NrWierszaFa>${idx + 1}</NrWierszaFa>`);
      lines.push(`      <P_7>${escapeXml(line.description)}</P_7>`);
      lines.push(`      <P_8A>${escapeXml(line.unit)}</P_8A>`);
      lines.push(`      <P_8B>${formatQuantity(line.quantity)}</P_8B>`);
      lines.push(`      <P_9A>${formatAmount(line.unitPriceNet)}</P_9A>`);
      lines.push(`      <P_11>${formatAmount(lineNet)}</P_11>`);
      lines.push(`      <P_12>${line.vatRate}</P_12>`);
      lines.push("    </FaWiersz>");
    });

    if (invoice.payment) {
      lines.push(this.buildPlatnosc(invoice.payment));
    }

    lines.push("  </Fa>");
    return lines.join("\n");
  }

  private buildPlatnosc(payment: PaymentInfo): string {
    // FA(3) <Zaplacono> is schema type TWybor1 — enum with only value "1"
    // (i.e. "this invoice has been paid"). For unpaid invoices the element
    // must be omitted entirely; presence alone signals "paid".
    const lines: string[] = [];
    lines.push("    <Platnosc>");
    if (payment.paid) {
      lines.push(`      <Zaplacono>1</Zaplacono>`);
      if (payment.paidDate) {
        lines.push(`      <DataZaplaty>${payment.paidDate}</DataZaplaty>`);
      }
    }
    if (payment.dueDate) {
      // TerminPlatnosci is a container with child <Termin> (date) and
      // optional <TerminOpis>. A flat <TerminPlatnosci>date</TerminPlatnosci>
      // fails FA(3) schema validation with "cannot contain text".
      lines.push("      <TerminPlatnosci>");
      lines.push(`        <Termin>${payment.dueDate}</Termin>`);
      lines.push("      </TerminPlatnosci>");
    }
    if (payment.formCode !== undefined) {
      lines.push(`      <FormaPlatnosci>${payment.formCode}</FormaPlatnosci>`);
    }
    lines.push("    </Platnosc>");
    return lines.join("\n");
  }
}

// --- Helpers --------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function round2(n: number): number {
  // Round half-away-from-zero with 2-decimal precision. Important for VAT
  // calculations — banker's rounding causes off-by-1 cents that fail
  // KSeF's strict total-checking validators.
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function formatAmount(n: number): string {
  // FA(3) wants amounts as decimal strings with 2 fixed places. No thousands
  // separators, no currency symbols, dot as the decimal separator (NOT
  // comma — Polish decimal-comma is for display only, the schema is dot).
  return n.toFixed(2);
}

function formatQuantity(n: number): string {
  // Quantities can be integers or fractions; Polish convention uses up to 4
  // decimal places. Strip trailing zeros for cleanliness.
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function isDateString(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}
