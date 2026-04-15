// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal FA(3) XML parser — extracts the fields we display in the popup.
// Uses DOMParser (available in SW context via `globalThis`).

export type ParsedInvoice = {
  invoiceNumber: string;
  issueDate: string;
  sellDate: string;
  currency: string;
  seller: { nip: string; name: string; address: string };
  buyer: { nip: string; name: string; address: string };
  totals: { net: number; vat: number; gross: number };
  dueDate: string | null;
  paymentForm: string | null;
  paid: boolean;
  lines: Array<{
    no: number;
    description: string;
    quantity: number;
    unit: string;
    unitPriceNet: number;
    lineNet: number;
    vatRate: string;
  }>;
};

function text(parent: Element | null, tag: string): string {
  if (!parent) return "";
  const el = parent.getElementsByTagName(tag)[0];
  return el?.textContent?.trim() ?? "";
}

function num(parent: Element | null, tag: string): number {
  const t = text(parent, tag);
  if (!t) return 0;
  return parseFloat(t.replace(",", "."));
}

function buildAddress(party: Element | null): string {
  if (!party) return "";
  const addr = party.getElementsByTagName("Adres")[0];
  if (!addr) return "";
  const parts: string[] = [];
  const l1 = text(addr, "AdresL1");
  const l2 = text(addr, "AdresL2");
  if (l1) parts.push(l1);
  if (l2) parts.push(l2);
  return parts.join(", ");
}

function parseParty(party: Element | null): { nip: string; name: string; address: string } {
  if (!party) return { nip: "", name: "", address: "" };
  const ident = party.getElementsByTagName("DaneIdentyfikacyjne")[0];
  return {
    nip: text(ident ?? null, "NIP"),
    name: text(ident ?? null, "Nazwa") || text(ident ?? null, "PelnaNazwa"),
    address: buildAddress(party),
  };
}

export function parseFa3(xmlString: string): ParsedInvoice {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "application/xml");

  // Handle namespaces: FA3 uses http://crd.gov.pl/wzor/...
  // getElementsByTagName ignores namespaces, so direct lookup works.
  const fa = doc.getElementsByTagName("Fa")[0];
  const podmiot1 = doc.getElementsByTagName("Podmiot1")[0];
  const podmiot2 = doc.getElementsByTagName("Podmiot2")[0];

  // Payment block
  const platnosc = fa?.getElementsByTagName("Platnosc")[0] ?? null;
  // TerminPlatnosci is a container: <TerminPlatnosci><Termin>YYYY-MM-DD</Termin></TerminPlatnosci>
  const terminPlatnosci = platnosc?.getElementsByTagName("TerminPlatnosci")[0] ?? null;
  const dueDate = text(terminPlatnosci, "Termin") || null;
  const paymentFormCode = text(platnosc, "FormaPlatnosci");
  const paymentForm = paymentFormCodeToName(paymentFormCode);
  const paid = text(platnosc, "Zaplacono") === "1";

  // Line items
  const lineEls = Array.from(fa?.getElementsByTagName("FaWiersz") ?? []);
  const lines = lineEls.map((el, i) => ({
    no: parseInt(text(el, "NrWierszaFa") || String(i + 1), 10),
    description: text(el, "P_7"),
    unit: text(el, "P_8A"),
    quantity: num(el, "P_8B"),
    unitPriceNet: num(el, "P_9A"),
    lineNet: num(el, "P_11"),
    vatRate: text(el, "P_12"),
  }));

  return {
    invoiceNumber: text(fa ?? null, "P_2"),
    issueDate: text(fa ?? null, "P_1"),
    sellDate: text(fa ?? null, "P_6"),
    currency: text(fa ?? null, "KodWaluty") || "PLN",
    seller: parseParty(podmiot1 ?? null),
    buyer: parseParty(podmiot2 ?? null),
    totals: {
      net: num(fa ?? null, "P_13_1"),
      vat: num(fa ?? null, "P_14_1"),
      gross: num(fa ?? null, "P_15"),
    },
    dueDate,
    paymentForm,
    paid,
    lines,
  };
}

function paymentFormCodeToName(code: string): string | null {
  // FA(3) standard codes
  const codes: Record<string, string> = {
    "1": "Gotówka",
    "2": "Karta",
    "3": "Bon",
    "4": "Czek",
    "5": "Kredyt",
    "6": "Przelew",
    "7": "Mobilna",
  };
  return codes[code] ?? null;
}
