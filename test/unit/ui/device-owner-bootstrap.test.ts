// ─── SEC-SETUP-BOOTSTRAP-001 · CR-1 — UI device-key seam ⇄ server proof ───
//
// Cross-correctness for the UI device-key wiring. The UI signs a transcript with
// WebCrypto; the SERVER verifier must accept it. These tests prove:
//   (A) the UI canonical encoder is BYTE-IDENTICAL to the server encoder,
//   (B) a WebCrypto (software) signature verifies against the REAL server S2a PoP
//       verifier (incl. low-S normalization), and
//   (C) the full UI orchestrator (challenge → claim → device-key login) mints a
//       real session against the REAL auth service when authority is enabled — and
//       fails closed when the device-key capability is unavailable.
//
// TRUTH LABEL: the WebCrypto keypair is a SOFTWARE dev key; it fabricates no
// attestation. The enabled branch is reached ONLY via the injectable authority
// seam (never by flipping the native constant).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayAuthService } from "#api";
import type { FridayAuthService } from "#api";
import { createFridayOwnerClaimPoPVerifier } from "../../../src/api/auth/device-attest/index.js";
import { encodeOwnerClaimTranscript as serverEncode } from "../../../src/api/auth/device-attest/index.js";
import type { OwnerClaimTranscript } from "../../../src/api/auth/device-attest/index.js";
import { createTestDb } from "../satellites/_helpers/create-test-db.helper.js";
import {
  createWebCryptoDeviceKeyProvider,
  encodeOwnerClaimTranscript as uiEncode,
  DeviceKeyUnavailableError,
  type DeviceClaimTranscript,
  type DeviceKeyProvider,
} from "../../../ui/src/lib/auth/device-key.js";
import { runDeviceOwnerBootstrap } from "../../../ui/src/lib/auth/device-owner-bootstrap.js";

const NOW = "2026-07-13T00:00:00.000Z";
const LOOPBACK = "127.0.0.1";
const ORIGIN = "https://friday.localhost";
const TOKEN_SECRET = "test-secret-key-for-ui-device-bootstrap-01"; // pragma: allowlist secret

function sampleTranscript(hash: string): DeviceClaimTranscript {
  return {
    transcriptVersion: "friday-owner-claim-v1",
    algorithm: "ECDSA_P256_SHA256",
    kind: "install_owner_claim",
    hubId: "test-hub",
    installId: "install-1",
    osUser: "ui",
    deviceId: "device-xyz",
    action: "owner-login",
    origin: ORIGIN,
    channel: "ui-loopback",
    nonce: "login-nonce-1",
    expiresAt: "2026-07-13T00:02:00.000Z",
    devicePublicKeyHash: hash,
  };
}

describe("CR-1 UI device-key seam ⇄ server verifier", () => {
  // ── (A) encoder byte-match ──

  it("the UI canonical encoder is byte-identical to the server encoder", () => {
    const t = sampleTranscript("a".repeat(64));
    const ui = Buffer.from(uiEncode(t));
    const server = serverEncode(t as unknown as OwnerClaimTranscript);
    expect(ui.equals(server)).toBe(true);
  });

  // ── (B) WebCrypto signature verifies against the real server PoP verifier ──

  it("a WebCrypto software signature verifies against the real S2a PoP verifier", async () => {
    const provider = createWebCryptoDeviceKeyProvider();
    expect(provider.isAvailable()).toBe(true);
    const key = await provider.getOrCreateDeviceKey();

    const transcript = sampleTranscript(key.devicePublicKeyHash);
    const signature = await provider.signTranscript(transcript);

    const verifier = createFridayOwnerClaimPoPVerifier();
    const result = verifier.verifyPossession({
      transcript: transcript as unknown as OwnerClaimTranscript,
      devicePublicKey: { encoding: "spki-der-base64", value: key.devicePublicKeySpkiBase64 },
      signature,
      nowMs: Date.parse(NOW),
    });
    expect(result.ok).toBe(true);
  });

  it("signTranscript fails closed before a key has been created", async () => {
    const provider = createWebCryptoDeviceKeyProvider();
    await expect(
      provider.signTranscript(sampleTranscript("b".repeat(64))),
    ).rejects.toBeInstanceOf(DeviceKeyUnavailableError);
  });

  // ── (C) full orchestrator end-to-end against the REAL auth service ──

  describe("full device-owner bootstrap against the real auth service", () => {
    let db: FridaySqliteLayer;

    function makeService(authorityEnabled: boolean): FridayAuthService {
      let n = 0;
      return createFridayAuthService({
        db,
        idGenerator: () => `id-${String(++n).padStart(4, "0")}`,
        nowIso: () => NOW,
        tokenSecret: TOKEN_SECRET,
        accessTokenTtlSec: 900,
        refreshTokenTtlSec: 604_800,
        hubId: "test-hub",
        bootstrapNonceTtlSec: 300,
        deviceOwnerAuthorityEnabled: () => authorityEnabled,
      });
    }

    function apiFor(svc: FridayAuthService) {
      return {
        issueChallenge: (input: { installId: string; osUser: string; origin: string }) =>
          Promise.resolve(svc.issueBootstrapChallenge(input, LOOPBACK) as never),
        claim: (input: Parameters<FridayAuthService["claimOwnerWithDeviceKey"]>[0]) =>
          Promise.resolve(svc.claimOwnerWithDeviceKey(input, LOOPBACK) as never),
        issueLoginChallenge: (input: Parameters<FridayAuthService["issueLoginChallenge"]>[0]) =>
          Promise.resolve(svc.issueLoginChallenge(input, LOOPBACK) as never),
        login: (input: Parameters<FridayAuthService["login"]>[0]) =>
          Promise.resolve(svc.login(input, LOOPBACK) as never),
      };
    }

    beforeEach(() => {
      db = createTestDb();
      db.withWriteTransaction((conn) => {
        conn.prepare("UPDATE users SET password_hash = NULL WHERE id = 'test-user'").run();
      });
    });

    afterEach(() => {
      db.close();
    });

    it("mints a real session end-to-end when device authority is enabled", async () => {
      const provider = createWebCryptoDeviceKeyProvider();
      const svc = makeService(true);
      const response = await runDeviceOwnerBootstrap(provider, apiFor(svc), {
        origin: ORIGIN,
        installId: "install-1",
        osUser: "ui",
      });
      expect(response.accessToken.length).toBeGreaterThan(0);
      expect(response.refreshToken.length).toBeGreaterThan(0);
      expect(response.user.id).toBe("test-user");
    });

    it("fails closed at the login leg when device authority is disabled", async () => {
      const provider = createWebCryptoDeviceKeyProvider();
      const svc = makeService(false); // real-build honest state
      await expect(
        runDeviceOwnerBootstrap(provider, apiFor(svc), {
          origin: ORIGIN,
          installId: "install-1",
          osUser: "ui",
        }),
      ).rejects.toThrow(/DEVICE_AUTHORITY_DISABLED|disabled/i);
    });

    it("orchestrator fails closed when the device-key capability is unavailable", async () => {
      const unavailable: DeviceKeyProvider = {
        isAvailable: () => false,
        getOrCreateDeviceKey: () => Promise.reject(new DeviceKeyUnavailableError()),
        signTranscript: () => Promise.reject(new DeviceKeyUnavailableError()),
      };
      const svc = makeService(true);
      await expect(
        runDeviceOwnerBootstrap(unavailable, apiFor(svc), {
          origin: ORIGIN,
          installId: "install-1",
          osUser: "ui",
        }),
      ).rejects.toBeInstanceOf(DeviceKeyUnavailableError);
    });
  });
});
