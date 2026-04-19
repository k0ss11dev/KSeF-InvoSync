// SPDX-License-Identifier: GPL-3.0-or-later
// FA(3) invoice upload pipeline. Wraps the three KSeF endpoints needed to
// push invoices into the system:
//
//   POST   /sessions/online                       → open session (returns referenceNumber)
//   POST   /sessions/online/{ref}/invoices        → upload one encrypted invoice
//   POST   /sessions/online/{ref}/close           → close session (and trigger UPO)
//
// Cryptographic envelope (verified against the cached OpenAPI spec
// at /v2/components/schemas/EncryptionInfo + SendInvoiceRequest):
//
//   1. Generate a fresh AES-256 key (32 bytes) per session.
//   2. Generate a fresh 16-byte IV per session — the SAME IV is used for
//      every invoice uploaded in that session. The KSeF spec wants the IV
//      passed once at session-open time, not per invoice.
//   3. Wrap the AES key with RSA-OAEP-SHA256 using the public key returned
//      by /security/public-key-certificates (we already have the import
//      logic in cert.ts).
//   4. POST /sessions/online with { formCode, encryption: { encryptedSymmetricKey, IV } }
//      and capture the session referenceNumber.
//   5. For each invoice XML produced by FA3Builder:
//        a. Compute SHA-256 of the plaintext UTF-8 bytes → invoiceHash
//        b. Get plaintext byte length → invoiceSize
//        c. AES-256-CBC + PKCS#7 encrypt with the session key + IV → ciphertext
//        d. Compute SHA-256 of the ciphertext → encryptedInvoiceHash
//        e. POST /sessions/online/{ref}/invoices with all five fields + offlineMode=false
//   6. POST /sessions/online/{ref}/close → 204
//
// All base64 values use the STANDARD alphabet, not base64url. The OpenAPI
// schema marks the relevant fields with `format: byte` which is the
// OpenAPI convention for standard base64.

import { redactBearerTokens } from "../shared/logger";
import type { CryptoKey } from "../shared/web-crypto-types";
// (we don't actually need that import — CryptoKey is a global, but I'm
// keeping the JSDoc clear about what's coming from where)

// --- Session lifecycle ---------------------------------------------------

export type OpenOnlineSessionOpts = {
  apiBaseUrl: string;
  /** OAuth-style bearer token from /auth/token/redeem (same one used for queries). */
  accessToken: string;
  /** KSeF public RSA key from /security/public-key-certificates → cert.ts. */
  ksefPublicKey: CryptoKey;
  /**
   * Form schema declaration. Default: FA(3) 1-0E. The schema must match
   * the XML you'll upload during the session — KSeF rejects mismatches.
   */
  formCode?: { systemCode: string; schemaVersion: string; value: string };
};

export type OnlineSessionContext = {
  /** Session reference number from /sessions/online. */
  referenceNumber: string;
  /** When the session auto-closes. ISO 8601. */
  validUntil: string;
  /**
   * The AES-256 key used to encrypt invoices in this session. Held in
   * memory only — never sent over the wire after the initial wrapped
   * version went out with /sessions/online.
   */
  symmetricKey: CryptoKey;
  /** 16-byte IV reused for all invoices in this session. */
  iv: Uint8Array;
};

export async function openOnlineSession(
  opts: OpenOnlineSessionOpts,
): Promise<OnlineSessionContext> {
  // 1. Fresh AES-256 + 16-byte IV per session.
  const symmetricKey = await crypto.subtle.generateKey(
    { name: "AES-CBC", length: 256 },
    true, // extractable so we can rawKey-export it for the RSA wrap
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(16));

  // 2. Export the AES key as raw bytes (32 bytes) and RSA-OAEP-SHA256 wrap it.
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", symmetricKey));
  const encryptedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    opts.ksefPublicKey,
    rawKey,
  );

  // 3. POST /sessions/online
  const baseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
  const formCode = opts.formCode ?? {
    systemCode: "FA (3)",
    schemaVersion: "1-0E",
    value: "FA",
  };

  const response = await fetch(`${baseUrl}/sessions/online`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.accessToken}`,
    },
    body: JSON.stringify({
      formCode,
      encryption: {
        encryptedSymmetricKey: bytesToBase64(new Uint8Array(encryptedKey)),
        initializationVector: bytesToBase64(iv),
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `POST /sessions/online failed: ${response.status} ${response.statusText}${text ? ` — ${redactBearerTokens(text)}` : ""}`,
    );
  }

  const json = (await response.json()) as {
    referenceNumber: string;
    validUntil: string;
  };

  return {
    referenceNumber: json.referenceNumber,
    validUntil: json.validUntil,
    symmetricKey,
    iv,
  };
}

// --- Invoice upload ------------------------------------------------------

export type UploadInvoiceOpts = {
  apiBaseUrl: string;
  accessToken: string;
  session: OnlineSessionContext;
  /** FA(3) XML string produced by FA3Builder.build(). */
  invoiceXml: string;
};

export type UploadInvoiceResult = {
  /** KSeF-assigned reference number for this specific invoice within the session. */
  referenceNumber: string;
};

export async function uploadInvoice(
  opts: UploadInvoiceOpts,
): Promise<UploadInvoiceResult> {
  const plaintextBytes = new TextEncoder().encode(opts.invoiceXml);

  // SHA-256 of plaintext
  const plaintextHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", plaintextBytes),
  );

  // AES-256-CBC + PKCS#7 (Web Crypto applies PKCS#7 automatically for AES-CBC)
  const ciphertextBytes = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: opts.session.iv },
      opts.session.symmetricKey,
      plaintextBytes,
    ),
  );

  // SHA-256 of ciphertext
  const ciphertextHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", ciphertextBytes),
  );

  const url = `${opts.apiBaseUrl.replace(/\/+$/, "")}/sessions/online/${encodeURIComponent(
    opts.session.referenceNumber,
  )}/invoices`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.accessToken}`,
    },
    body: JSON.stringify({
      invoiceHash: bytesToBase64(plaintextHash),
      invoiceSize: plaintextBytes.length,
      encryptedInvoiceHash: bytesToBase64(ciphertextHash),
      encryptedInvoiceSize: ciphertextBytes.length,
      encryptedInvoiceContent: bytesToBase64(ciphertextBytes),
      offlineMode: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `POST ${url} failed: ${response.status} ${response.statusText}${text ? ` — ${redactBearerTokens(text)}` : ""}`,
    );
  }

  const json = (await response.json()) as { referenceNumber: string };
  return { referenceNumber: json.referenceNumber };
}

// --- Session close -------------------------------------------------------

export type CloseOnlineSessionOpts = {
  apiBaseUrl: string;
  accessToken: string;
  session: OnlineSessionContext;
};

export async function closeOnlineSession(opts: CloseOnlineSessionOpts): Promise<void> {
  const url = `${opts.apiBaseUrl.replace(/\/+$/, "")}/sessions/online/${encodeURIComponent(
    opts.session.referenceNumber,
  )}/close`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  if (!response.ok && response.status !== 204) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `POST ${url} failed: ${response.status} ${response.statusText}${text ? ` — ${redactBearerTokens(text)}` : ""}`,
    );
  }
}

// --- High-level helper ---------------------------------------------------

export type UploadInvoicesOpts = {
  apiBaseUrl: string;
  accessToken: string;
  ksefPublicKey: CryptoKey;
  /** XML strings produced by FA3Builder, one per invoice. */
  invoiceXmls: string[];
  /** Called after each invoice uploads — useful for progress UI / CLI logging. */
  onProgress?: (info: {
    index: number;
    total: number;
    invoiceReferenceNumber: string;
  }) => void;
};

export type UploadInvoicesResult = {
  sessionReferenceNumber: string;
  invoiceReferenceNumbers: string[];
};

/**
 * Open a session, upload N invoices, close the session. The "I just want
 * to push some invoices" convenience wrapper. Closes the session even on
 * partial failure (best-effort, in a finally).
 */
export async function uploadInvoices(
  opts: UploadInvoicesOpts,
): Promise<UploadInvoicesResult> {
  const session = await openOnlineSession({
    apiBaseUrl: opts.apiBaseUrl,
    accessToken: opts.accessToken,
    ksefPublicKey: opts.ksefPublicKey,
  });

  const invoiceReferenceNumbers: string[] = [];
  try {
    for (let i = 0; i < opts.invoiceXmls.length; i++) {
      const result = await uploadInvoice({
        apiBaseUrl: opts.apiBaseUrl,
        accessToken: opts.accessToken,
        session,
        invoiceXml: opts.invoiceXmls[i],
      });
      invoiceReferenceNumbers.push(result.referenceNumber);
      opts.onProgress?.({
        index: i,
        total: opts.invoiceXmls.length,
        invoiceReferenceNumber: result.referenceNumber,
      });
    }
  } finally {
    // Best-effort close — never throws because the upload result is the
    // important thing. Real KSeF auto-closes sessions after validUntil
    // anyway.
    try {
      await closeOnlineSession({
        apiBaseUrl: opts.apiBaseUrl,
        accessToken: opts.accessToken,
        session,
      });
    } catch {
      // swallow
    }
  }

  return {
    sessionReferenceNumber: session.referenceNumber,
    invoiceReferenceNumbers,
  };
}

// --- Helpers -------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
