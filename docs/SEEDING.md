# Seeding Test Invoices

For local development and testing against the real KSeF test environment (`api-test.ksef.mf.gov.pl`), use `scripts/seed-test-invoices.mjs`.

## Prerequisites

1. **KSeF test account** — create one at https://ap-test.ksef.mf.gov.pl/
2. **Generate a token** — KSeF web app → Tokens → new token
3. **Save token** — write the full bundle to `tests/fixtures/real-ksef-token.local`:
   ```
   20260412-EC-XXXXXX|nip-NNNNNNNNNN|hex_token_here
   ```

## Usage

### Issue outgoing invoices (seller = you)

```bash
node scripts/seed-test-invoices.mjs 5
```

Issues 5 test invoices where the seller is the NIP from your token. The buyer is auto-generated (synthetic Polish NIP with valid checksum).

### Issue incoming invoices (buyer = specific NIP)

For testing the incoming invoice feature, you need TWO test accounts:
- **Account A** (NIP X) — the one logged into the extension
- **Account B** (NIP Y) — issues invoices TO Account A

Put Account B's token in the file, then:

```bash
node scripts/seed-test-invoices.mjs 3 --buyer-nip 8698281999
```

This issues 3 invoices where:
- Seller = Account B's NIP (from token)
- Buyer = `8698281999` (Account A)

Then switch to Account A's token in the extension and sync — the invoices appear as incoming.

## What the script does

```
1. Bundle src/ksef/fa3-builder.ts + fa3-test-data.ts via esbuild (on the fly)
2. Authenticate against api-test.ksef.mf.gov.pl
3. Open an online upload session (AES-256-CBC + RSA-OAEP key wrap)
4. Generate N FA(3) XML invoices with valid Polish NIPs
5. Encrypt + POST each to /sessions/online/{ref}/invoices
6. Close the session
7. Print KSeF reference numbers for verification
```

Each invoice is saved to `tests/fixtures/.seed-invoice-*.local.xml` for inspection (gitignored).

## Troubleshooting

| Error | Fix |
|---|---|
| `auth never reached success (last code=450)` | Token is wrong/expired. Regenerate at ap-test.ksef.mf.gov.pl |
| `415 Błąd odszyfrowania` | Used wrong cert type (`KsefTokenEncryption` vs `SymmetricKeyEncryption`) |
| `500 Wystąpił nieoczekiwany błąd` | Invoice XML failed KSeF's XSD validation. Check `<JST>` + `<GV>` on `<Podmiot2>` |
| `404 on /security/public-key-certificates` | Missing `/v2` path prefix |
| Invoices accepted but never appear in `/invoices/query/metadata` | **Async validation rejected them.** Run `node scripts/check-session-status.mjs <session-ref>` to see per-invoice errors. See "Silent rejection" below. |

## Silent rejection — async schema validation

KSeF's upload flow is **two-phase**:

1. `POST /sessions/online/{ref}/invoices` — synchronous, returns `200` + a KSeF reference number. This only means the envelope parsed; the invoice XML is **not yet validated**.
2. Asynchronous FA(3) XSD + semantic validation runs in the background. If it fails, the invoice gets status `450 Błąd weryfikacji semantyki` and is silently dropped — never reaches permanent storage, never shows up in metadata queries.

**The session looks "successful" to the seed script**, but the downstream query returns nothing new.

**Diagnose with:**
```bash
node scripts/check-session-status.mjs 20260414-SO-XXXXXXXXX
```

Output shows `invoiceCount`, `successfulInvoiceCount`, and `/invoices/failed` with the exact XSD error (e.g. `"The value '2' is invalid according to its datatype 'TWybor1'"`).

### Known FA(3) schema gotchas (learned by burning ~10 test invoices)

| Element | Wrong (rejected) | Correct |
|---|---|---|
| `<Zaplacono>` | `<Zaplacono>2</Zaplacono>` for unpaid | **Omit the element entirely.** Schema type `TWybor1` only allows value `1` (= paid). Presence alone signals "paid"; absence signals "unpaid". |
| `<TerminPlatnosci>` | `<TerminPlatnosci>2026-04-28</TerminPlatnosci>` | It's a container, not a leaf: `<TerminPlatnosci><Termin>2026-04-28</Termin></TerminPlatnosci>` (optional `<TerminOpis>` sibling). |

These bugs produce `450 Błąd weryfikacji semantyki dokumentu faktury` with details pointing to the offending namespace — look for messages like *"cannot contain text"* (container vs leaf mismatch) or *"Enumeration constraint failed"* (bad enum value).

**Rule of thumb:** if you add a new FA(3) field to `fa3-builder.ts`, **always** run `check-session-status.mjs` after the first seed to verify async validation passed. The session-close response is not a validation signal.
