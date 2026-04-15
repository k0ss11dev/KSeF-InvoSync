# Invoice Data Model

## Why a "StructuredInvoice" type?

FA(3) is the Polish XML schema for e-invoices in KSeF. It has 100+ possible fields, most optional. We use an intermediate `StructuredInvoice` TypeScript type as the single source of truth — the XML builder (`FA3Builder`) consumes it.

```
┌──────────────────┐    ┌───────────────────┐    ┌──────────────┐
│  Input source    │───►│ StructuredInvoice │───►│  FA3Builder  │───► FA(3) XML
│                  │    │  (TS object)      │    │              │
└──────────────────┘    └───────────────────┘    └──────────────┘
```

The intermediate TS type is the single source of truth — the XML builder is agnostic to input source, so the same pipeline supports test data, future form UIs, or any other structured source.

## Current input: `generateTestInvoiceBatch()`

Deterministic test data with valid Polish NIPs. Used for seeding, unit tests, manual testing.

```ts
const invoices = generateTestInvoiceBatch(5, {
  seed: 42,  // deterministic
  seller: { nip: "5861719741" },
  buyer: { nip: "8698281999" },
});
```

Produces 5 invoices with synthetic line items (consulting, training, support) and realistic Polish names/addresses.

## FA(3) schema quirks we handle

| Quirk | Handling |
|---|---|
| `<JST>` + `<GV>` mandatory on `<Podmiot2>` (buyer) | Auto-added with defaults (`2`, `2`) |
| Two cert types (`KsefTokenEncryption` vs `SymmetricKeyEncryption`) | Separate cert pickers for each use case |
| Async auth (poll `/auth/{ref}` until code=200) | Dedicated poller in `src/ksef/auth.ts` |
| Token format is the WHOLE bundle, not just hex | Documented + tested against real env |
| Polish NIP/REGON/PESEL checksum algorithms | Generators in `src/ksef/polish-ids.ts` (48 tests) |
| `namespace="http://crd.gov.pl/wzor/2025/06/25/13775/"` | Hardcoded in FA3Builder |
| `permanentStorageDate` for incremental sync (monotonic) | Used as the dedup anchor |

All discovered the hard way against `api-test.ksef.mf.gov.pl` — see git history for full war stories.
