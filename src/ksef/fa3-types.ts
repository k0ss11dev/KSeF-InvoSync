// SPDX-License-Identifier: GPL-3.0-or-later
// StructuredInvoice — the source-agnostic domain model for an invoice this
// extension knows how to issue. The downstream FA3Builder turns it into a
// valid FA(3) XML string for KSeF upload.
//
// Why a separate "structured" type instead of going straight to FA(3) XML?
//
// Because the FA(3) schema is a serialization format with Polish element
// names and arcane field codes (P_7, P_8A, P_13_1, etc.). It's awful as
// an internal API surface. Anything that produces an invoice — test data,
// photo OCR, PDF extraction, natural-language LLM, manual form input —
// produces a StructuredInvoice first, and only the builder knows about
// FA(3) field names.
//
// Architecture:
//
//   ┌──────────────────────┐
//   │ Test data factory    │──────┐
//   │ (fa3-test-data.ts)   │      │
//   └──────────────────────┘      │
//                                  │
//   ┌──────────────────────┐      │
//   │ Photo OCR + LLM      │──────┤
//   │ (FUTURE — M3+)       │      │
//   └──────────────────────┘      │      ┌────────────────────┐      ┌──────────────┐
//                                  ├─────►│ StructuredInvoice  │─────►│ FA3Builder   │─────► FA(3) XML
//   ┌──────────────────────┐      │      └────────────────────┘      │ (this file's │       string
//   │ PDF text extraction  │──────┤                                   │ sibling)     │
//   │ (FUTURE — M3+)       │      │                                   └──────────────┘
//   └──────────────────────┘      │                                          │
//                                  │                                          ▼
//   ┌──────────────────────┐      │                                  (M3 sub-turn 4-LATER:
//   │ Natural-language LLM │──────┤                                   open session, encrypt
//   │ (FUTURE — M3+)       │      │                                   with AES-GCM, upload
//   └──────────────────────┘      │                                   to /v2/sessions/online/
//                                  │                                   {ref}/invoices)
//   ┌──────────────────────┐      │
//   │ Popup form (manual)  │──────┘
//   │ (FUTURE — M3+)       │
//   └──────────────────────┘
//
// The point of this layering: when we eventually add "snap a photo of a
// handwritten invoice and upload it to KSeF" (which is the killer feature
// from idea catalog 02-smb-enhancement-ideas.md → B3 Voice/photo → invoice),
// we add ONE module that maps a photo to a StructuredInvoice. The builder,
// the upload pipeline, and everything downstream stays unchanged.

/**
 * The full structured invoice. Source-agnostic. All fields use natural
 * English/domain names — Polish FA(3) field codes only appear in the builder.
 */
export type StructuredInvoice = {
  metadata: InvoiceMetadata;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  lines: InvoiceLine[];
  payment?: PaymentInfo;
};

export type InvoiceMetadata = {
  /** Invoice number, e.g. "FA/2026/04/0001". Maps to FA(3) `<P_2>`. */
  invoiceNumber: string;
  /** Issue date, YYYY-MM-DD. Maps to `<P_1>`. */
  issueDate: string;
  /** City of issue, e.g. "Warszawa". Maps to `<P_1M>`. Optional. */
  issuePlace?: string;
  /** Date of sale or service. YYYY-MM-DD. Maps to `<P_6>`. Defaults to issueDate. */
  sellDate?: string;
  /** ISO 4217 currency code, e.g. "PLN", "EUR". Maps to `<KodWaluty>`. */
  currency: string;
  /** Invoice type. v1 only supports "VAT" — extend later for Korekta etc. */
  invoiceType: "VAT";
  /** Free-text identifier for which system generated this invoice. Maps to `<SystemInfo>`. */
  systemInfo?: string;
};

/**
 * A taxpayer party — used for both seller (Podmiot1) and buyer (Podmiot2).
 */
export type InvoiceParty = {
  /** 10-digit Polish NIP. Maps to `<NIP>`. */
  nip: string;
  /** Legal name. Maps to `<Nazwa>`. */
  name: string;
  address: PartyAddress;
  contact?: PartyContact;
};

export type PartyAddress = {
  /** ISO 3166-1 alpha-2 country code. "PL" for Poland. Maps to `<KodKraju>`. */
  countryCode: string;
  /** First address line, e.g. street + house number "ul. Kępa 332". Maps to `<AdresL1>`. */
  line1: string;
  /** Second address line, typically "postcode city" e.g. "20-892 Tyszowce". Maps to `<AdresL2>`. */
  line2: string;
};

export type PartyContact = {
  /** Email address. Maps to `<Email>`. */
  email?: string;
  /** Phone number. Maps to `<Telefon>`. */
  phone?: string;
};

/**
 * A single line item on the invoice. Net amount is computed automatically by
 * the builder as `quantity * unitPriceNet` rounded to 2 decimals — we don't
 * accept it as input to avoid the "two-fields-disagree" footgun.
 */
export type InvoiceLine = {
  /** Description of goods/services. Maps to `<P_7>`. */
  description: string;
  /** Unit of measure, e.g. "szt." (pieces), "godz." (hours), "kg", "m²". Maps to `<P_8A>`. */
  unit: string;
  /** Quantity. Maps to `<P_8B>`. */
  quantity: number;
  /** Net unit price (excluding VAT). Maps to `<P_9A>`. */
  unitPriceNet: number;
  /** Polish VAT rate code. Maps to `<P_12>`. */
  vatRate: VatRate;
};

/**
 * Polish VAT rate codes used in FA(3).
 *   "23"  standard rate (most common)
 *   "8"   reduced rate (some food, restaurants, hotels, transport)
 *   "5"   super-reduced rate (basic food, books, periodicals)
 *   "0"   zero-rated (export, intra-community supply)
 *   "zw"  zwolnione — exempt
 *   "oo"  odwrotne obciążenie — reverse charge (B2B services)
 *   "np"  nie podlega — not subject to Polish VAT
 */
export type VatRate = "23" | "8" | "5" | "0" | "zw" | "oo" | "np";

export type PaymentInfo = {
  /** Whether the invoice is already paid. Maps to `<Zaplacono>` (1=true, 2=false). */
  paid: boolean;
  /** Date paid. YYYY-MM-DD. Maps to `<DataZaplaty>`. Required when paid=true. */
  paidDate?: string;
  /** Payment due date. YYYY-MM-DD. Maps to `<TerminPlatnosci>`. */
  dueDate?: string;
  /**
   * Payment form code per FA(3). Common values:
   *   1 = cash (gotówka)
   *   6 = bank transfer (przelew)
   *   7 = card (karta)
   * Maps to `<FormaPlatnosci>`.
   */
  formCode?: number;
};
