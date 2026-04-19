// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal ASN.1 DER walker — exists for one job: extract the SubjectPublicKeyInfo
// (SPKI) bytes from an X.509 certificate, so we can feed them to
// crypto.subtle.importKey('spki', ...).
//
// Not a general-purpose ASN.1 library. Handles only enough to walk the X.509
// Certificate → TBSCertificate → SubjectPublicKeyInfo path. Anything more
// elaborate (parsing OIDs, decoding INTEGERs, validating signatures) is out
// of scope — we just need the raw SPKI subtree, including its outer SEQUENCE
// header, exactly as `importKey('spki', ...)` expects it.
//
// Why hand-rolled instead of @peculiar/x509 or similar:
//   The "no third-party deps in the crypto path" rule from the security memo.
//   X.509 parsing is adjacent to crypto, not crypto itself, but a 100-line
//   parser is reviewable in a single sitting and fails loud on bad input
//   (importKey rejects garbage SPKI, encryption produces results the server
//   rejects). Externalising this would mean trusting a third-party package
//   to read certificates whose contents go straight into our key import.

export type AsnNode = {
  /** First byte of the encoding — tag class + constructed bit + tag number. */
  tag: number;
  /** Decoded length value (number of content bytes). */
  length: number;
  /** Content bytes only (no tag, no length). */
  contents: Uint8Array;
  /** Full bytes including tag + length + contents — useful when re-emitting. */
  raw: Uint8Array;
};

/**
 * Parse a single Tag-Length-Value at `offset` in `bytes`. Returns the node
 * with `raw` spanning from the tag byte through the end of contents.
 */
export function parseTLV(bytes: Uint8Array, offset: number): AsnNode {
  if (offset >= bytes.length) {
    throw new Error(`asn1: offset ${offset} beyond input length ${bytes.length}`);
  }

  const tag = bytes[offset];
  let pos = offset + 1;
  if (pos >= bytes.length) {
    throw new Error("asn1: truncated input after tag byte");
  }

  let length = bytes[pos];
  pos++;

  if (length & 0x80) {
    // Long-form length: low 7 bits = number of length bytes (1..4 supported).
    const numLengthBytes = length & 0x7f;
    if (numLengthBytes === 0) {
      throw new Error("asn1: indefinite-length form is not supported in DER");
    }
    if (numLengthBytes > 4) {
      throw new Error(`asn1: length encoded in ${numLengthBytes} bytes is too large`);
    }
    if (pos + numLengthBytes > bytes.length) {
      throw new Error("asn1: truncated input in length bytes");
    }
    // Use arithmetic (not bitwise shift) — JavaScript's << is 32-bit signed,
    // so a 4-byte length with the top bit set becomes negative, and the
    // end-of-buffer check below trivially passes with a negative `end`,
    // letting bytes.slice() silently return an empty array.
    length = 0;
    for (let i = 0; i < numLengthBytes; i++) {
      length = length * 256 + bytes[pos + i];
    }
    if (length < 0 || !Number.isFinite(length)) {
      throw new Error("asn1: invalid length value");
    }
    // Sanity cap: no legitimate X.509 cert has an SPKI subtree anywhere
    // near 10 MB. The 4-byte length field could encode up to 4 GiB —
    // catching obviously-wrong values here keeps the parser honest.
    const MAX_LENGTH = 10 * 1024 * 1024;
    if (length > MAX_LENGTH) {
      throw new Error(`asn1: length ${length} exceeds safety cap`);
    }
    pos += numLengthBytes;
  }

  const end = pos + length;
  if (end > bytes.length) {
    throw new Error(
      `asn1: declared length ${length} at offset ${offset} exceeds input bounds`,
    );
  }

  return {
    tag,
    length,
    contents: bytes.slice(pos, end),
    raw: bytes.slice(offset, end),
  };
}

/**
 * Parse all child TLVs of a constructed node (SEQUENCE / SET / etc).
 */
export function children(parent: AsnNode): AsnNode[] {
  const result: AsnNode[] = [];
  let offset = 0;
  while (offset < parent.contents.length) {
    const node = parseTLV(parent.contents, offset);
    result.push(node);
    offset += node.raw.length;
  }
  return result;
}

/**
 * Extract the SubjectPublicKeyInfo (SPKI) raw bytes from an X.509 DER cert.
 *
 * X.509 layout (RFC 5280):
 *   Certificate ::= SEQUENCE {
 *     tbsCertificate       TBSCertificate,
 *     signatureAlgorithm   AlgorithmIdentifier,
 *     signatureValue       BIT STRING
 *   }
 *
 *   TBSCertificate ::= SEQUENCE {
 *     [0] EXPLICIT version (optional, default v1)  -- context tag 0xa0
 *     serialNumber         CertificateSerialNumber,
 *     signature            AlgorithmIdentifier,
 *     issuer               Name,
 *     validity             Validity,
 *     subject              Name,
 *     subjectPublicKeyInfo SubjectPublicKeyInfo,    <-- TARGET
 *     ...optional fields after
 *   }
 *
 * Returns the SPKI subtree bytes including its outer SEQUENCE header — that's
 * exactly what `crypto.subtle.importKey('spki', ...)` expects.
 */
export function extractSpkiFromCertDer(certDer: Uint8Array): Uint8Array {
  const cert = parseTLV(certDer, 0);
  if (cert.tag !== 0x30) {
    throw new Error(
      `asn1: expected outer Certificate to be SEQUENCE (0x30), got 0x${cert.tag.toString(16)}`,
    );
  }

  const certChildren = children(cert);
  if (certChildren.length < 3) {
    throw new Error(
      `asn1: Certificate has ${certChildren.length} children, expected at least 3`,
    );
  }

  const tbs = certChildren[0];
  if (tbs.tag !== 0x30) {
    throw new Error(
      `asn1: TBSCertificate is not a SEQUENCE (got tag 0x${tbs.tag.toString(16)})`,
    );
  }

  const tbsChildren = children(tbs);

  // The version field is [0] EXPLICIT, encoded as context-specific tag 0xa0.
  // If it's present, SPKI is at index 6 (version, serial, sig, issuer,
  // validity, subject, spki). If absent (v1 default), SPKI is at index 5.
  let spkiIndex = 5;
  if (tbsChildren[0]?.tag === 0xa0) {
    spkiIndex = 6;
  }

  if (spkiIndex >= tbsChildren.length) {
    throw new Error(
      `asn1: SPKI expected at TBSCertificate index ${spkiIndex}, only ${tbsChildren.length} fields present`,
    );
  }

  const spki = tbsChildren[spkiIndex];
  if (spki.tag !== 0x30) {
    throw new Error(
      `asn1: SubjectPublicKeyInfo is not a SEQUENCE (got tag 0x${spki.tag.toString(16)})`,
    );
  }

  return spki.raw;
}

/**
 * Convenience: parse a base64-encoded DER cert (the format the KSeF API
 * returns in the `certificate` field) and extract its SPKI.
 */
export function extractSpkiFromCertBase64(certBase64: string): Uint8Array {
  return extractSpkiFromCertDer(base64ToBytes(certBase64));
}

/**
 * Convenience: parse a PEM-encoded cert (with -----BEGIN CERTIFICATE-----
 * markers) and extract its SPKI.
 */
export function extractSpkiFromCertPem(pem: string): Uint8Array {
  const stripped = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return extractSpkiFromCertBase64(stripped);
}

/** Standard base64 (NOT base64url — PEM/X.509 uses the standard alphabet). */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
