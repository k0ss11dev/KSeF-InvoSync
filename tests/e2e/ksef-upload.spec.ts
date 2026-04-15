// SPDX-License-Identifier: GPL-3.0-or-later
// M3 sub-turn 4-LATER: e2e for the FA(3) invoice upload pipeline.
// Drives openOnlineSession → uploadInvoice → closeOnlineSession against the
// local mock server, which decrypts everything with the test private key
// and exposes the decrypted XMLs so we can assert end-to-end:
//
//   FA3Builder → StructuredInvoice → XML string
//             → AES-256-CBC encrypt with session key + IV
//             → SHA-256 hash + base64 + POST to /sessions/online/{ref}/invoices
//             → mock decrypts → plaintext === FA3Builder output
//
// If this round-trips byte-for-byte, the wire format is correct against
// real KSeF too (the only thing the mock doesn't do is the FA(3) XSD
// business-rule validation that the real server runs after acceptance).

import { expect, test } from "./fixtures/extension";
import {
  startMockKsefServer,
  type MockKsefServer,
} from "../mocks/ksef-server";

const SAMPLE_KSEF_TOKEN = "fake-ksef-test-token-AAAA-BBBB";
const SAMPLE_NIP = "0000000000";

test.describe("M3 sub-turn 4-LATER — FA(3) upload pipeline against mock", () => {
  let mock: MockKsefServer;

  test.beforeAll(async () => {
    mock = await startMockKsefServer();
  });

  test.afterAll(async () => {
    await mock?.close();
  });

  test.beforeEach(() => {
    mock.reset();
  });

  test("openOnlineSession → uploadInvoice → mock decrypts to original XML", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(
      async ({ apiBaseUrl, ksefToken, nip }) => {
        const auth = (
          globalThis as unknown as {
            __ksefAuthForTests: typeof import("../../src/ksef/auth");
          }
        ).__ksefAuthForTests;
        const cert = (
          globalThis as unknown as {
            __ksefForTests: typeof import("../../src/ksef/cert");
          }
        ).__ksefForTests;
        const upload = (
          globalThis as unknown as {
            __ksefUploadForTests: typeof import("../../src/ksef/upload");
          }
        ).__ksefUploadForTests;
        const fa3Builder = (
          globalThis as unknown as {
            __fa3BuilderForTests: typeof import("../../src/ksef/fa3-builder");
          }
        ).__fa3BuilderForTests;
        const fa3TestData = (
          globalThis as unknown as {
            __fa3TestDataForTests: typeof import("../../src/ksef/fa3-test-data");
          }
        ).__fa3TestDataForTests;

        // Auth (same flow tests have already proven this works)
        const session = await auth.authenticateWithKsefToken({
          apiBaseUrl,
          ksefToken,
          contextIdentifier: { type: "Nip", value: nip },
        });

        // Fetch the public key (mock returns the test cert)
        const publicKey = await cert.fetchKsefTokenEncryptionKey(apiBaseUrl);

        // Open an upload session
        const uploadSession = await upload.openOnlineSession({
          apiBaseUrl,
          accessToken: session.accessToken.token,
          ksefPublicKey: publicKey.publicKey,
        });

        // Build one FA(3) invoice
        const builder = new fa3Builder.FA3Builder();
        const invoice = fa3TestData.generateTestInvoice({ seed: 12345 });
        const xml = builder.build(invoice);

        // Upload it
        const uploadResult = await upload.uploadInvoice({
          apiBaseUrl,
          accessToken: session.accessToken.token,
          session: uploadSession,
          invoiceXml: xml,
        });

        // Close
        await upload.closeOnlineSession({
          apiBaseUrl,
          accessToken: session.accessToken.token,
          session: uploadSession,
        });

        return {
          sessionRef: uploadSession.referenceNumber,
          invoiceRef: uploadResult.referenceNumber,
          originalXml: xml,
        };
      },
      { apiBaseUrl: mock.url, ksefToken: SAMPLE_KSEF_TOKEN, nip: SAMPLE_NIP },
    );

    expect(result.sessionRef).toMatch(/^MOCK-SO-/);
    expect(result.invoiceRef).toMatch(/^MOCK-EE-/);

    // Mock should have one session with one decrypted invoice that matches
    // the XML the client encrypted.
    const mockSession = mock.onlineSessions.get(result.sessionRef);
    expect(mockSession).toBeDefined();
    expect(mockSession!.status).toBe("closed");
    expect(mockSession!.uploadedInvoices.length).toBe(1);
    const decrypted = mockSession!.uploadedInvoices[0].decryptedXml;
    expect(decrypted).toBe(result.originalXml);
    // Spot-check that the decrypted XML is FA(3)
    expect(decrypted).toContain('<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">');
    expect(decrypted).toContain("<KodFormularza");
    expect(decrypted).toContain("<P_2>");
  });

  test("uploadInvoices high-level helper opens, uploads N, closes, returns refs", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(
      async ({ apiBaseUrl, ksefToken, nip }) => {
        const auth = (
          globalThis as unknown as {
            __ksefAuthForTests: typeof import("../../src/ksef/auth");
          }
        ).__ksefAuthForTests;
        const cert = (
          globalThis as unknown as {
            __ksefForTests: typeof import("../../src/ksef/cert");
          }
        ).__ksefForTests;
        const upload = (
          globalThis as unknown as {
            __ksefUploadForTests: typeof import("../../src/ksef/upload");
          }
        ).__ksefUploadForTests;
        const fa3Builder = (
          globalThis as unknown as {
            __fa3BuilderForTests: typeof import("../../src/ksef/fa3-builder");
          }
        ).__fa3BuilderForTests;
        const fa3TestData = (
          globalThis as unknown as {
            __fa3TestDataForTests: typeof import("../../src/ksef/fa3-test-data");
          }
        ).__fa3TestDataForTests;

        const session = await auth.authenticateWithKsefToken({
          apiBaseUrl,
          ksefToken,
          contextIdentifier: { type: "Nip", value: nip },
        });
        const publicKey = await cert.fetchKsefTokenEncryptionKey(apiBaseUrl);

        const builder = new fa3Builder.FA3Builder();
        const invoices = fa3TestData.generateTestInvoiceBatch(5, { seed: 7 });
        const xmls = invoices.map((inv) => builder.build(inv));

        const onProgressCalls: number[] = [];
        const uploadResult = await upload.uploadInvoices({
          apiBaseUrl,
          accessToken: session.accessToken.token,
          ksefPublicKey: publicKey.publicKey,
          invoiceXmls: xmls,
          onProgress: (info) => {
            onProgressCalls.push(info.index);
          },
        });

        return {
          sessionRef: uploadResult.sessionReferenceNumber,
          invoiceRefs: uploadResult.invoiceReferenceNumbers,
          progressCount: onProgressCalls.length,
          xmls,
        };
      },
      { apiBaseUrl: mock.url, ksefToken: SAMPLE_KSEF_TOKEN, nip: SAMPLE_NIP },
    );

    expect(result.invoiceRefs.length).toBe(5);
    expect(result.invoiceRefs.every((r) => r.startsWith("MOCK-EE-"))).toBe(true);
    expect(result.progressCount).toBe(5);

    const mockSession = mock.onlineSessions.get(result.sessionRef);
    expect(mockSession).toBeDefined();
    expect(mockSession!.uploadedInvoices.length).toBe(5);
    expect(mockSession!.status).toBe("closed");

    // All 5 decrypted XMLs match what the client sent, in order.
    for (let i = 0; i < 5; i++) {
      expect(mockSession!.uploadedInvoices[i].decryptedXml).toBe(result.xmls[i]);
    }
  });

  test("uploadInvoice rejects with 401 on bogus access token", async ({
    serviceWorker,
  }) => {
    const errorMessage = await serviceWorker.evaluate(async (apiBaseUrl) => {
      const cert = (
        globalThis as unknown as {
          __ksefForTests: typeof import("../../src/ksef/cert");
        }
      ).__ksefForTests;
      const upload = (
        globalThis as unknown as {
          __ksefUploadForTests: typeof import("../../src/ksef/upload");
        }
      ).__ksefUploadForTests;

      const publicKey = await cert.fetchKsefTokenEncryptionKey(apiBaseUrl);
      try {
        await upload.openOnlineSession({
          apiBaseUrl,
          accessToken: "bogus-access-token",
          ksefPublicKey: publicKey.publicKey,
        });
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    }, mock.url);

    expect(errorMessage).toMatch(/401/);
  });

  test("closing an unknown session returns 404", async ({ serviceWorker }) => {
    const errorMessage = await serviceWorker.evaluate(
      async ({ apiBaseUrl, ksefToken, nip }) => {
        const auth = (
          globalThis as unknown as {
            __ksefAuthForTests: typeof import("../../src/ksef/auth");
          }
        ).__ksefAuthForTests;
        const upload = (
          globalThis as unknown as {
            __ksefUploadForTests: typeof import("../../src/ksef/upload");
          }
        ).__ksefUploadForTests;

        const session = await auth.authenticateWithKsefToken({
          apiBaseUrl,
          ksefToken,
          contextIdentifier: { type: "Nip", value: nip },
        });

        try {
          await upload.closeOnlineSession({
            apiBaseUrl,
            accessToken: session.accessToken.token,
            session: {
              referenceNumber: "MOCK-SO-DOESNOTEXIST",
              validUntil: new Date(Date.now() + 3600_000).toISOString(),
              symmetricKey: {} as CryptoKey,
              iv: new Uint8Array(16),
            },
          });
          return null;
        } catch (err) {
          return (err as Error).message;
        }
      },
      { apiBaseUrl: mock.url, ksefToken: SAMPLE_KSEF_TOKEN, nip: SAMPLE_NIP },
    );

    expect(errorMessage).toMatch(/404/);
  });
});
