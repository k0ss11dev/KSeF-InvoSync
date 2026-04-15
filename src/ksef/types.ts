// SPDX-License-Identifier: GPL-3.0-or-later
// Type definitions for the subset of the KSeF 2.0 REST API that this
// extension uses in v1: token-based auth + invoice metadata query.
//
// Source: https://github.com/CIRFMF/ksef-docs/blob/main/open-api.json
// Cached locally at KSeF-Research/.research-cache/ksef-open-api.json

// --- Common ---------------------------------------------------------------

export type ContextIdentifierType = "Nip" | "InternalId" | "VatUe";

export type ContextIdentifier = {
  type: ContextIdentifierType;
  value: string;
};

// --- /security/public-key-certificates -----------------------------------

export type PublicKeyUsage = "KsefTokenEncryption" | "SymmetricKeyEncryption";

export type PublicKeyCertificate = {
  /** Base64-encoded DER X.509 certificate. */
  certificate: string;
  /** ISO 8601 timestamp with timezone offset. */
  validFrom: string;
  validTo: string;
  usage: PublicKeyUsage[];
};

// --- /auth/challenge -----------------------------------------------------

export type AuthChallengeResponse = {
  challenge: string;
  /** ISO 8601 timestamp with timezone — for display only. */
  timestamp: string;
  /** Unix milliseconds — this is what we put in the encrypted envelope. */
  timestampMs: number;
  clientIp?: string;
};

// --- /auth/ksef-token ----------------------------------------------------

export type AuthorizationPolicy = {
  allowedIps?: string[];
};

export type KsefTokenAuthRequest = {
  challenge: string;
  contextIdentifier: ContextIdentifier;
  /**
   * Base64-encoded RSA-OAEP-SHA256 encryption of the payload
   *   `${ksefToken}|${timestampMs}`
   * using the KsefTokenEncryption public key from /security/public-key-certificates.
   */
  encryptedToken: string;
  authorizationPolicy?: AuthorizationPolicy;
};

export type AuthInitResponse = {
  referenceNumber: string;
  authenticationToken: {
    token: string; // JWT
    validUntil: string;
  };
};

// --- /auth/{referenceNumber} (auth status polling) ---------------------

/**
 * KSeF authentication is asynchronous: /auth/ksef-token returns 202 with a
 * temporary `authenticationToken` JWT, and the actual token validation
 * happens in the background. Clients must poll GET /auth/{referenceNumber}
 * (using the JWT as Bearer) until status.code reaches 200 before calling
 * /auth/token/redeem.
 *
 * Status codes seen against the real test env:
 *   100  Uwierzytelnianie w toku                — in progress, keep polling
 *   200  Uwierzytelnianie zakończone sukcesem   — success, ready to redeem
 *   400  Uwierzytelnianie zakończone niepowodzeniem — failed (cert / chain / etc)
 *   450  Uwierzytelnianie zakończone niepowodzeniem z powodu błędnego tokenu
 *        — token rejected (wrong value, expired, revoked, used)
 */
export type AuthStatusResponse = {
  startDate: string;
  authenticationMethod: string;
  status: {
    code: number;
    description: string;
    details?: string[];
  };
};

// --- /auth/token/redeem and /auth/token/refresh --------------------------

export type AuthTokensResponse = {
  accessToken: { token: string; validUntil: string };
  refreshToken: { token: string; validUntil: string };
};

export type AuthTokenRefreshResponse = {
  accessToken: { token: string; validUntil: string };
};

// --- /invoices/query/metadata --------------------------------------------
// Shapes verified against the cached OpenAPI spec
// (KSeF-Research/.research-cache/ksef-open-api.json, schemas
// `InvoiceQueryFilters` and `QueryInvoicesMetadataResponse`).

/**
 * Which side of the invoice are we querying from?
 *   Subject1 — querying as the seller / issuer (own outgoing invoices)
 *   Subject2 — querying as the buyer / receiver (incoming invoices)
 */
export type InvoiceQuerySubjectType = "Subject1" | "Subject2";

/**
 * Which date column the `from`/`to` range applies to. PermanentStorage is the
 * recommended choice for incremental sync (it's the moment the invoice was
 * archived in KSeF, so it's monotonic and resilient to backdated invoices).
 */
export type InvoiceQueryDateType = "PermanentStorage" | "Invoicing" | "Issue";

export type InvoiceQueryFilters = {
  subjectType: InvoiceQuerySubjectType;
  dateRange: {
    dateType: InvoiceQueryDateType;
    /** ISO 8601 with timezone offset. */
    from: string;
    to: string;
  };
  // Optional filters — we don't use them in v1 but they're documented here
  // so callers can pass them through without us needing to extend the type:
  amount?: { type: "Brutto" | "Netto"; from?: number; to?: number };
  currencyCodes?: string[];
  invoicingMode?: "Online" | "Offline";
  formType?: string;
  invoiceTypes?: string[];
  hasAttachment?: boolean;
};

export type InvoiceQueryResponse = {
  invoices: InvoiceMetadata[];
  hasMore: boolean;
  isTruncated: boolean;
  /** High-water mark for incremental sync — pass back as `from` next time. */
  permanentStorageHwmDate?: string;
};

export type SubjectIdentifier = {
  type: ContextIdentifierType;
  value: string;
};

export type InvoiceParty = {
  /** Direct NIP for sellers; for buyers it's nested under `identifier`. */
  nip?: string;
  identifier?: SubjectIdentifier;
  name?: string;
};

export type InvoiceMetadata = {
  ksefNumber: string;
  invoiceNumber: string;
  issueDate: string;
  invoicingDate: string;
  acquisitionDate?: string;
  permanentStorageDate: string;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  netAmount?: number;
  grossAmount?: number;
  vatAmount?: number;
  currency?: string;
  invoicingMode?: "Online" | "Offline";
  invoiceType?: string;
  formCode?: {
    systemCode: string;
    schemaVersion: string;
    value: string;
  };
  isSelfInvoicing?: boolean;
  hasAttachment?: boolean;
  invoiceHash?: string;
  thirdSubjects?: unknown[];
};
